const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

async function testGemini() {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    // Models to test
    const models = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-1.0-pro"];

    for (const modelName of models) {
        console.log(`Testing model: ${modelName}...`);
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent("Hello, are you there?");
            console.log(`✅ SUCCESS: ${modelName} responded:`, result.response.text());
            return; // Exit on first success
        } catch (error) {
            console.error(`❌ FAILED: ${modelName}`, error.message);
        }
    }
    console.log("⚠️ ALL MODELS FAILED. Check API Key permissions.");
}

testGemini();
