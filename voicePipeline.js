// voicePipeline.js
import { SpeechClient } from '@google-cloud/speech';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { GoogleGenerativeAI } from "@google/generative-ai";

// Initialize clients
const speechClient = new SpeechClient();
const ttsClient = new TextToSpeechClient();
const genAI = new GoogleGenerativeAI(process.env.GoogleAPIKey);

/**
 * Converts an audio buffer to text using Google STT
 */
async function transcribeAudio(audioBuffer) {
  const audio = { content: audioBuffer.toString('base64') };
  const config = {
    encoding: 'OGG_OPUS',       // match your Twilio format
    sampleRateHertz: 8000,
    languageCode: 'en-US',
  };
  const [response] = await speechClient.recognize({ audio, config });
  const transcription = response.results
    .map(r => r.alternatives[0].transcript)
    .join('\n');
  return transcription;
}

/**
 * Generates a response from Gemini AI
 */
async function generateAIResponse(promptText) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  const result = await model.generateContent(promptText);
  return result.response.text();
}

/**
 * Converts text to audio buffer using Google TTS
 */
async function synthesizeSpeech(text) {
  const request = {
    input: { text },
    voice: { languageCode: 'en-US', ssmlGender: 'NEUTRAL' },
    audioConfig: { audioEncoding: 'MP3' },
  };
  const [response] = await ttsClient.synthesizeSpeech(request);
  return response.audioContent;
}

/**
 * Main pipeline: STT -> Gemini -> TTS
 */
export async function processVoiceRequest(incomingAudioBuffer) {
  try {
    const transcribedText = await transcribeAudio(incomingAudioBuffer);
    const aiResponse = await generateAIResponse(transcribedText);
    const audioBuffer = await synthesizeSpeech(aiResponse);
    return audioBuffer;
  } catch (err) {
    console.error("Voice pipeline error:", err);
    throw err;
  }
}
