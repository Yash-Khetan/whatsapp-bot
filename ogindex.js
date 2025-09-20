// const express = require('express');
import express from "express"
// const twilio = require('twilio');
import twilio from "twilio"
import axios from "axios"
import cron from "node-cron"
import { GoogleGenerativeAI } from "@google/generative-ai";

import dotenv from "dotenv";
dotenv.config();
// const axios = require('axios');
// const cron = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: false }));


// Configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY ;
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);




// Store user subscriptions (use database in production)
const subscribers = new Set();
const userLocations = new Map();
const userPreferences = new Map(); // phone -> { language: 'en' }

// Weather API function
async function getWeather(city) {
  try {
    const response = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${WEATHER_API_KEY}&units=metric`
    );
    
    const weather = response.data;
    const alerts = [];
    
    // Define alert conditions
    if (weather.main.temp > 35) {
      alerts.push(`🌡️ Heat Alert: ${weather.main.temp}°C`);
    }
    if (weather.main.temp < 5) {
      alerts.push(`❄️ Cold Alert: ${weather.main.temp}°C`);
    }
    if (weather.wind.speed > 10) {
      alerts.push(`💨 Wind Alert: ${weather.wind.speed} m/s`);
    }
    if (weather.weather[0].main === 'Rain') {
      alerts.push(`🌧️ Rain Alert: ${weather.weather[0].description}`);
    }
    if (weather.weather[0].main === 'Thunderstorm') {
      alerts.push(`⛈️ Storm Alert: ${weather.weather[0].description}`);
    }
    
    return {
      city: weather.name,
      temp: weather.main.temp,
      description: weather.weather[0].description,
      alerts: alerts,
      wind : weather.wind
    };
  } catch (error) {
    console.error('Weather API error:', error);
    return null;
  }
}
// get crop advice based on weather
function getCropAdvice(weather) {
  const advice = [];

  if (weather.temp > 35) {
    advice.push("Consider heat-tolerant crops like millet or sorghum.");
  }
  if (weather.temp > 20 && weather.temp <= 35) {
    advice.push("This is a good time for vegetables like spinach or okra.");
  }
  if (
    weather.description.includes('rain') ||
    weather.description.includes('mist') ||
    weather.description.includes('fog')
  ) {
    advice.push("High humidity: monitor for fungal diseases.");
  }
  if (weather.wind.speed > 10) {
    advice.push("Protect young plants with windbreaks.");
  }

  if (advice.length === 0) {
    advice.push("No specific tips for this weather. Monitor your fields regularly.");
  }

  return advice;
}

// using the gemini api key to get the farming advice based on weather data
const genAI = new GoogleGenerativeAI(process.env.GoogleAPIKey);

async function getCropAdviceAI(weather) {
   try {
    const prompt = `Given this weather: 
  Temperature: ${weather.temp}°C,
  Conditions: ${weather.description}, 
  Wind speed: ${weather.wind.speed} m/s.
  
  Suggest 3 suitable crops and 1 pesticide and 1 fertilizer recommendation for farmers. 
  Keep the advice short and within 1400 character limit`;
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    console.error("Gemini error:", err);
    return "Could not fetch AI advice right now.";
  }
}


// Send WhatsApp message
async function sendWhatsAppMessage(to, message) {
  try {
    await client.messages.create({
      body: message,
      from: 'whatsapp:+14155238886', // Twilio sandbox number
      to: `whatsapp:${to}` // <-- FIXED: use the function argument
    });
  } catch (error) {
    console.error('WhatsApp send error:', error);
  }
}

// text translation function using google translate api
async function translateText(text, langCode) {
  const prompt = `Translate the following text to ${langCode}:\n\n${text}`;
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  const result = await model.generateContent(prompt);
  return result.response.text();
}


// Handle incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body.toLowerCase().trim();
  const from = req.body.From.replace('whatsapp:', '');
  
  let response = '';
  // initial message to set language preference
  if (!userPreferences.has(from)) {
  userPreferences.set(from, { language: 'en' }); // default
  await sendWhatsAppMessage(from,
    "👋 Welcome! This is your one stop solution for getting all the weather upodates.\nThen send 'subscribe Mumbai' to start."
  );
}

  if (incomingMsg.startsWith('subscribe')) {
    const city = incomingMsg.replace('subscribe', '').trim();
    
    if (city) {
      subscribers.add(from);
      userLocations.set(from, city);
      response = `✅ Subscribed to weather alerts for ${city}!\n\nYou'll receive alerts for:\n• Extreme temperatures\n• Heavy rain/storms\n• Strong winds\n\nSend "unsubscribe" to stop alerts.`;
    } else {
      response = 'Please specify a city. Example: "subscribe Mumbai"';
    }
  }
  else if (incomingMsg === 'unsubscribe') {
    subscribers.delete(from);
    userLocations.delete(from);
    response = '❌ Unsubscribed from weather alerts.';
  }
  else if (incomingMsg.startsWith('weather')) {
  const city = incomingMsg.replace('weather', '').trim() || userLocations.get(from);
  if (city) {
    const weather = await getWeather(city);
    if (weather) {
      response = `🌤️ Current weather in ${weather.city}:\n\n🌡️ Temperature: ${weather.temp}°C\n☁️ Conditions: ${weather.description}`;
      if (weather.alerts.length > 0) {
        response += `\n\n⚠️ ALERTS:\n${weather.alerts.join('\n')}`;
      }

      // ⬇️ Add this part - new part when getting crop advice 
      const aiAdvice = await getCropAdviceAI(weather);
      
      if (aiAdvice.length > 0) {
        response += `\n\n🌱 *Farming Tips*:\n${aiAdvice}`;;
      }
      // ⬆️ End of added part

    } else {
      response = 'Sorry, could not fetch weather data. Please check the city name.';
    }
  } else {
    response = 'Please specify a city. Example: "weather Mumbai"';
  }
}

  else {
    response = `🤖 Weather Alert Bot Commands:

📍 *subscribe [city]* - Get weather alerts
❌ *unsubscribe* - Stop alerts  
🌤️ *weather [city]* - Current weather
❓ *help* - Show this message

Example: "subscribe Mumbai"`;
  }
  // Handle language preference
  const userLang = userPreferences.get(from)?.language || 'en';
  if (userLang !== 'en') {
  response = await translateText(response, userLang);
}
  // Send response
  await sendWhatsAppMessage(from, response);
  res.status(200).send('OK');
});

// Automated alert checking (every 3 hours)
cron.schedule('0 */3 * * *', async () => {
  console.log('Checking weather alerts...');
  
  for (const [phone, city] of userLocations) {
    if (subscribers.has(phone)) {
      const weather = await getWeather(city);
      
      if (weather && weather.alerts.length > 0) {
        const alertMessage = `🚨 WEATHER ALERT - ${weather.city}\n\n${weather.alerts.join('\n')}\n\nStay safe! 🙏`;
        await sendWhatsAppMessage(phone, alertMessage);
        
        // Add delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('WhatsApp Weather Bot is running!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


