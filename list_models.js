const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
    try {
        const models = await genAI.getGenerativeModel({ model: "gemini-1.5-flash" }).apiKey; // Hacky check? No, use listModels
        // The SDK doesn't expose listModels helper directly on genAI instance in older versions?
        // Let's try to just fetch the list if possible, or print what we can.
        // Actually, checking documentation: genAI currently doesn't have a listModels method in the high-level helper?
        // We might need to use the lower level `GoogleGenerativeAI.getGenerativeModel`... 
        // Wait, let's just try to fetch a specific one to see if it responds.

        // But better: Use the API directly to list models.
        const apiKey = process.env.GEMINI_API_KEY;
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await response.json();

        console.log("AVAILABLE MODELS:");
        if (data.models) {
            data.models.forEach(m => {
                console.log(`- ${m.name} (${m.displayName}) [Supported: ${m.supportedGenerationMethods}]`);
            });
        } else {
            console.log("No models found or error:", data);
        }

    } catch (e) {
        console.error("Error listing models:", e);
    }
}

listModels();
