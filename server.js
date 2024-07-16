const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer');
require('dotenv').config();
const fs = require('fs');
const cron = require('node-cron');
const util = require('util');
const WebSocket = require('ws');
const readFile = util.promisify(fs.readFile);

const app = express();
const port = 3000;

const ITEMS_PER_PAGE = 20;

let allWeatherData = {
  today: [],
  tomorrow: [],
  yesterday: []
};
let isDataLoading = false;

class WeatherFetcher {
  constructor(url) {
    this.url = url;
  }

  async fetchWeatherData(lat, lng) {
    const postData = {
      latitude: lat,
      longitude: lng,
      query: {
        hourly: ['cape'],
        daily: ['temperature_2m_max', 'temperature_2m_min', 'wind_speed_10m_max', 'precipitation_sum']
      }
    };

    try {
      const response = await axios.post(this.url, postData, {
        headers: { 'Content-Type': 'application/json' }
      });
      return response.data;
    } catch (error) {
      console.error('Error making API request:', error.message);
      return null;
    }
  }

  async processLocations(filePath, page = 1) {
    const data = await readFile(filePath, 'utf8');
    const locations = JSON.parse(data);

    const start = (page - 1) * ITEMS_PER_PAGE;
    const end = page * ITEMS_PER_PAGE;
    const locationsPage = locations.slice(start, end);

    const weatherDataPromises = locationsPage.map(location => this.fetchWeatherData(parseFloat(location.lat), parseFloat(location.lng)));
    const weatherDataResults = await Promise.all(weatherDataPromises);

    let todayResults = [];
    let tomorrowResults = [];

    for (let i = 0; i < locationsPage.length; i++) {
      const weatherData = weatherDataResults[i];
      if (weatherData) {
        todayResults.push(this.createWeatherRow(locationsPage[i], weatherData, 0));
        tomorrowResults.push(this.createWeatherRow(locationsPage[i], weatherData, 1));
      }
    }

    return { today: todayResults, tomorrow: tomorrowResults };
  }

  createWeatherRow(location, weatherData, dayOffset) {
    const baseIndex = dayOffset >= 0 ? dayOffset : weatherData.daily.temperature_2m_max.length + dayOffset;
    return {
      city: location.sehir,
      district: location.semt,
      lat: location.lat,
      long: location.lng,
      maxTemp: weatherData.daily.temperature_2m_max[baseIndex],
      minTemp: weatherData.daily.temperature_2m_min[baseIndex],
      maxWindSpeed: weatherData.daily.wind_speed_10m_max[baseIndex],
      maxCape: Math.max(...weatherData.hourly.cape.slice(24 * baseIndex, 24 * (baseIndex + 1))),
      prcp24h: weatherData.daily.precipitation_sum[baseIndex],
      prcp48h: dayOffset >= 0 ? weatherData.daily.precipitation_sum[baseIndex] + (weatherData.daily.precipitation_sum[baseIndex + 1] || 0) : undefined,
      prcp72h: dayOffset >= 0 ? (weatherData.daily.precipitation_sum[baseIndex] + (weatherData.daily.precipitation_sum[baseIndex + 1] || 0) + (weatherData.daily.precipitation_sum[baseIndex + 2] || 0)) : undefined
    };
  }
}

class PuppeteerFetcher {
  async fetchData(url, selector, category) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForSelector(selector);
    const data = await page.evaluate((selector, category) => {
      const rows = Array.from(document.querySelectorAll(selector));
      return rows.map(row => {
        const columns = row.querySelectorAll('td.ng-binding');
        return {
          city_info: columns[0].textContent.trim(),
          value: category === 'Precipitation Sum (mm)' ? parseFloat(columns[1].textContent.trim().replace(',', '.')) : parseFloat(columns[1].textContent.trim()),
          category: category
        };
      });
    }, selector, category);
    await browser.close();
    return data;
  }

  async fetchAndSaveData() {
    const urls = [
      { url: 'https://mgm.gov.tr/sondurum/en-yuksek-sicakliklar.aspx', category: 'Max Temperature (C)' },
      { url: 'https://mgm.gov.tr/sondurum/en-dusuk-sicakliklar.aspx', category: 'Min Temperature (C)' },
      { url: 'https://mgm.gov.tr/sondurum/toplam-yagis.aspx', category: 'Precipitation Sum (mm)' }
    ];

    const allResults = await Promise.all(urls.map(({ url, category }) => this.fetchData(url, 'tr.ng-scope', category)));

    const flattenedResults = allResults.flat();

    flattenedResults.sort((a, b) => {
      if (a.category === 'Precipitation Sum (mm)' && b.category === 'Precipitation Sum (mm)') {
        return b.value - a.value;
      }
      return 0;
    });

    let yesterdayResults = [];

    flattenedResults.forEach(result => {
      const [City, District] = result.city_info.split(',');
      let existingRow = yesterdayResults.find(row => row.city === City.trim() && row.district === District.trim());
      if (!existingRow) {
        existingRow = {
          city: City.trim(),
          district: District.trim(),
          maxTemp: undefined,
          minTemp: undefined,
          prcp24h: undefined
        };
        yesterdayResults.push(existingRow);
      }
      existingRow[result.category] = result.value;
    });

    return yesterdayResults;
  }
}

const startDataLoading = async () => {
  if (isDataLoading) return;
  isDataLoading = true;
  const weatherFetcher = new WeatherFetcher('https://8ohij8472m.execute-api.eu-central-1.amazonaws.com/prod/forecast');
  const puppeteerFetcher = new PuppeteerFetcher();

  let page = 1;
  allWeatherData = { today: [], tomorrow: [], yesterday: [] }; // Reset the data

  // Fetch yesterday's data first
  const yesterdayResults = await puppeteerFetcher.fetchAndSaveData();
  allWeatherData.yesterday = yesterdayResults;

  // Fetch today's and tomorrow's data
  while (true) {
    const results = await weatherFetcher.processLocations('filtered_ililce.json', page);
    if (results.today.length === 0) break; // No more data to fetch
    allWeatherData.today = allWeatherData.today.concat(results.today);
    allWeatherData.tomorrow = allWeatherData.tomorrow.concat(results.tomorrow);
    page++;
    await new Promise(resolve => setTimeout(resolve, 1000)); // Adding delay to prevent flooding
  }

  isDataLoading = false;
  console.log('Data loading completed.');
};

app.use(express.static('public'));

// HTTP endpoint for serving the initial HTML page
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// HTTP endpoint for fetching all loaded weather data
app.get('/weather', (req, res) => {
  res.json(allWeatherData);
});

const server = app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
  startDataLoading(); // Start loading data when the server starts
});

// WebSocket server setup
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('New client connected');

  // Send the initial data to the client
  ws.send(JSON.stringify(allWeatherData));

  ws.on('message', (message) => {
    console.log(`Received message => ${message}`);
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Her sabah saat 6'da yeni veri çekmek için cron job
cron.schedule('0 6 * * *', async () => {
  console.log('Scheduled task started at 6:00 AM');
  startDataLoading();
});
