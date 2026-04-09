import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

const app = express();

// ✅ FIX 1: Enable CORS for all routes — allows MCP Inspector to connect
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
}));

// ✅ FIX 2: Handle preflight OPTIONS requests
app.options('*', cors());

// ─────────────────────────────────────────
// MCP Server Setup
// ─────────────────────────────────────────
const mcpServer = new McpServer({
  name: "weather-mcp",
  version: "1.0.0"
});

// TOOL 1: Get Current Weather
mcpServer.tool(
  "get_current_weather",
  "Get current weather for any city using Open-Meteo (free, no API key)",
  {
    city: z.string().describe("City name, e.g. London, Tokyo, New York")
  },
  async ({ city }) => {
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`
    );
    const geoData = await geoRes.json();

    if (!geoData.results || geoData.results.length === 0) {
      return { content: [{ type: "text", text: `City "${city}" not found.` }] };
    }

    const { latitude, longitude, name, country } = geoData.results[0];

    const weatherRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code` +
      `&temperature_unit=celsius`
    );
    const weatherData = await weatherRes.json();
    const c = weatherData.current;

    const result = `
📍 Location   : ${name}, ${country}
🌡️ Temperature : ${c.temperature_2m}°C
💧 Humidity    : ${c.relative_humidity_2m}%
💨 Wind Speed  : ${c.wind_speed_10m} km/h
🌤️ Condition   : ${getWeatherDescription(c.weather_code)}
    `.trim();

    return { content: [{ type: "text", text: result }] };
  }
);

// TOOL 2: Get 3-Day Forecast
mcpServer.tool(
  "get_weather_forecast",
  "Get a 3-day weather forecast for any city",
  {
    city: z.string().describe("City name, e.g. Paris, Dubai, Sydney")
  },
  async ({ city }) => {
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`
    );
    const geoData = await geoRes.json();

    if (!geoData.results || geoData.results.length === 0) {
      return { content: [{ type: "text", text: `City "${city}" not found.` }] };
    }

    const { latitude, longitude, name, country } = geoData.results[0];

    const forecastRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
      `&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum` +
      `&temperature_unit=celsius&forecast_days=3&timezone=auto`
    );
    const forecastData = await forecastRes.json();
    const d = forecastData.daily;

    let forecast = `📍 3-Day Forecast for ${name}, ${country}:\n\n`;
    for (let i = 0; i < 3; i++) {
      forecast += `📅 ${d.time[i]}\n`;
      forecast += `   🌡️ Max: ${d.temperature_2m_max[i]}°C  Min: ${d.temperature_2m_min[i]}°C\n`;
      forecast += `   🌧️ Rain: ${d.precipitation_sum[i]} mm\n`;
      forecast += `   🌤️ ${getWeatherDescription(d.weather_code[i])}\n\n`;
    }

    return { content: [{ type: "text", text: forecast.trim() }] };
  }
);

// ─────────────────────────────────────────
// Helper: Weather Code → Description
// ─────────────────────────────────────────
function getWeatherDescription(code) {
  const codes = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Icy fog", 51: "Light drizzle", 53: "Moderate drizzle",
    61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    71: "Slight snow", 73: "Moderate snow", 75: "Heavy snow",
    80: "Slight showers", 81: "Moderate showers", 82: "Violent showers",
    95: "Thunderstorm", 99: "Thunderstorm with hail"
  };
  return codes[code] ?? "Unknown condition";
}

// ─────────────────────────────────────────
// SSE Transport
// ─────────────────────────────────────────
const transports = {};

app.get('/sse', async (req, res) => {
  // ✅ FIX 3: Correct SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders(); // ✅ FIX 4: Flush headers immediately

  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;

  req.on('close', () => {
    delete transports[transport.sessionId];
    console.log(`Session ${transport.sessionId} disconnected`);
  });

  await mcpServer.connect(transport);
});

// ✅ FIX 5: Raw body for /messages — do NOT parse with express.json()
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  console.log(`Message received for session: ${sessionId}`);
  const transport = transports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    console.log(`No transport found for sessionId: ${sessionId}`);
    res.status(400).json({ error: 'Session not found' });
  }
});

// ─────────────────────────────────────────
// Health & Root routes
// ─────────────────────────────────────────
app.use(express.json()); // Only applied after /messages route

app.get('/', (req, res) => {
  res.json({
    message: '🌤️ Weather MCP Server is running!',
    endpoints: ['/health', '/sse', '/messages']
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', server: 'Weather MCP (Open-Meteo)', tools: 2 });
});

app.listen(3000, () => console.log('🌤️ Weather MCP Server running on port 3000!'));