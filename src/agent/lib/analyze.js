const sharp = require('sharp');
const axios = require('axios');

async function analyzeActivity({ buffer, enableOcr, enableColor, enableLmStudio, includeWindowTitle, tesseract, host, lmStudioConfig }) {
  const details = {};
  let summaryParts = [];
  let confidence = null;

  // LM Studio analysis takes priority if enabled
  if (enableLmStudio && lmStudioConfig) {
    try {
      const lmResult = await analyzeWithLmStudio(buffer, lmStudioConfig);
      details.lmStudioAnalysis = lmResult.analysis;
      details.activityType = lmResult.activityType;
      details.isSchoolWork = lmResult.isSchoolWork;
      details.isLocked = lmResult.isLocked;
      details.category = lmResult.category;
      summaryParts.push(lmResult.summary);
      confidence = lmResult.confidence;
    } catch (error) {
      details.lmStudioError = error.message;
      console.error('LM Studio analysis failed:', error.message);
      // Fall back to other methods if LM Studio fails
    }
  }

  if (enableColor) {
    const colorInfo = await extractDominantColor(buffer);
    details.dominantColor = colorInfo;
    if (!summaryParts.length) {
      summaryParts.push(`Dominant color ${colorInfo.hex}`);
    }
  }

  if (enableOcr) {
    try {
      const text = await runOcr(buffer, tesseract);
      details.ocrText = text;
      if (text.trim() && !summaryParts.length) {
        summaryParts.push(`Detected text snippet: "${text.substring(0, 60).trim()}"`);
        confidence = 0.8;
      }
    } catch (error) {
      details.ocrError = error.message;
    }
  }

  if (includeWindowTitle && host.windowTitle) {
    summaryParts.push(`Window: ${host.windowTitle}`);
  }

  if (!summaryParts.length) {
    summaryParts = ['Unknown activity'];
  }

  return {
    summary: summaryParts.join(' | '),
    confidence,
    details,
  };
}

async function analyzeWithLmStudio(imageBuffer, config) {
  const startTime = Date.now();
  
  // Resize image to reduce processing time and payload size
  // Most vision models work well with 1024px or smaller images
  const resizedBuffer = await sharp(imageBuffer)
    .resize(config.resizeWidth || 1024, config.resizeHeight || 1024, { 
      fit: 'inside',
      withoutEnlargement: true 
    })
    .png()
    .toBuffer();
  
  const base64Image = resizedBuffer.toString('base64');
  const imageSizeKB = Math.round(base64Image.length / 1024);
  
  console.log(`[LM Studio] Sending ${imageSizeKB}KB image to ${config.model}`);
  
  const prompt = `You are analyzing a screenshot from a computer to determine if the user is doing school-related work, non-school activities, or if the screen is locked/inactive.

Analyze this screenshot and provide:
1. A brief description of what you see (1-2 sentences)
2. Which category this falls into: SCHOOL_WORK, NON_SCHOOL, or LOCKED_INACTIVE
3. A specific category (e.g., "Mathematics", "Writing", "Gaming", "Social Media", "Lock Screen", "Screen Saver", etc.)
4. Your confidence level (0.0 to 1.0)

Respond in this exact JSON format:
{
  "description": "brief description here",
  "activityType": "SCHOOL_WORK" or "NON_SCHOOL" or "LOCKED_INACTIVE",
  "category": "category name",
  "confidence": 0.0 to 1.0
}

SCHOOL_WORK includes:
- Educational content (textbooks, academic articles, learning platforms)
- Math/science problems or equations
- Programming for coursework
- Research or writing assignments
- Educational videos or lectures
- Study materials or notes

NON_SCHOOL includes:
- Social media (Facebook, Twitter, Instagram, TikTok, etc.)
- Entertainment (gaming, Netflix, YouTube entertainment, etc.)
- Personal communication (messaging, email not related to school)
- Shopping or browsing for non-educational purposes
- General web browsing for entertainment

LOCKED_INACTIVE includes:
- Lock screens or login screens
- Screen savers
- Blank/black screens with no activity
- System dialogs blocking access (e.g., password prompts, UAC dialogs)
- "Away" or "Do Not Disturb" screens
- Screensaver patterns or images
- Any screen that prevents normal computer use`;

  try {
    const response = await axios.post(
      config.apiUrl,
      {
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: prompt
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${base64Image}`
                }
              }
            ]
          }
        ],
        max_tokens: config.maxTokens || 300,
        temperature: config.temperature || 0.3
      },
      {
        timeout: config.timeoutMs || 180000,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[LM Studio] Response received in ${elapsed}s`);

    const content = response.data.choices[0].message.content;
    
    // Try to parse JSON response
    let parsed;
    try {
      // Extract JSON from markdown code blocks if present
      const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || content.match(/(\{[\s\S]*\})/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[1]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      // If parsing fails, create a basic response from the text
      console.warn('Failed to parse LM Studio JSON response, using text fallback');
      const isLocked = /lock.*screen|screen.*saver|locked|inactive|login|password|blocked/i.test(content);
      const isSchool = !isLocked && /school.*work|educational|study|homework|assignment/i.test(content);
      
      let activityType = 'NON_SCHOOL';
      let category = 'Non-School Activity';
      
      if (isLocked) {
        activityType = 'LOCKED_INACTIVE';
        category = 'Locked/Inactive';
      } else if (isSchool) {
        activityType = 'SCHOOL_WORK';
        category = 'School Work';
      }
      
      parsed = {
        description: content.substring(0, 150),
        activityType: activityType,
        category: category,
        confidence: 0.5
      };
    }

    // Determine emoji based on activity type
    let emoji = '🎮'; // NON_SCHOOL
    let label = 'NON-SCHOOL';
    
    if (parsed.activityType === 'SCHOOL_WORK') {
      emoji = '📚';
      label = 'SCHOOL WORK';
    } else if (parsed.activityType === 'LOCKED_INACTIVE') {
      emoji = '🔒';
      label = 'LOCKED/INACTIVE';
    }

    return {
      analysis: content,
      activityType: parsed.activityType,
      isSchoolWork: parsed.activityType === 'SCHOOL_WORK',
      isLocked: parsed.activityType === 'LOCKED_INACTIVE',
      category: parsed.category,
      confidence: parsed.confidence,
      summary: `${emoji} ${label}: ${parsed.category} - ${parsed.description}`
    };
  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      throw new Error('LM Studio API not available. Make sure LM Studio is running on ' + config.apiUrl);
    }
    throw new Error(`LM Studio API error: ${error.message}`);
  }
}

async function extractDominantColor(buffer) {
  const { data } = await sharp(buffer)
    .resize(32, 32, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let r = 0;
  let g = 0;
  let b = 0;
  const totalPixels = data.length / 3;
  for (let i = 0; i < data.length; i += 3) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }

  r = Math.round(r / totalPixels);
  g = Math.round(g / totalPixels);
  b = Math.round(b / totalPixels);

  const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;

  return { r, g, b, hex };
}

function toHex(value) {
  return value.toString(16).padStart(2, '0');
}

async function runOcr(buffer, tesseract) {
  const { data } = await tesseract.recognize(buffer, 'eng');
  return data.text || '';
}

module.exports = {
  analyzeActivity,
};

