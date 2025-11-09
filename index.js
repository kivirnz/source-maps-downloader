const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const sourceMap = require('source-map');
const puppeteer = require('puppeteer');
const { URL } = require('url');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');

// Extract all chunk file references from JS content
function extractChunkReferences(jsContent, baseUrl) {
  const chunks = new Set();
  
  // Pattern 1: Webpack chunk manifest - n.u = e => "path/" + ({id: "name"}[e]||e) + "." + {id: "hash"}[e] + ".chunk.js"
  const chunkManifestPattern = /n\.u\s*=\s*e\s*=>\s*["']([^"']+)["']\s*\+\s*\(\{([^}]+)\}\[e\][^+]*\)\s*\+\s*["']([^"']*?)["']\s*\+\s*\{([^}]+)\}\[e\]\s*\+\s*["']([^"']+)["']/g;
  
  let manifestMatch;
  while ((manifestMatch = chunkManifestPattern.exec(jsContent)) !== null) {
    const basePath = manifestMatch[1]; // "static/js/"
    const nameMap = manifestMatch[2]; // 102:"xlsx",133:"pdfmake"
    const middlePart = manifestMatch[3]; // "."
    const hashMap = manifestMatch[4]; // 13:"552027bd",59:"8a314126"
    const extension = manifestMatch[5]; // ".chunk.js"
    
    // Parse the name map {102:"xlsx",133:"pdfmake"}
    const nameMatches = nameMap.matchAll(/(\d+)\s*:\s*["']([^"']+)["']/g);
    const names = {};
    for (const match of nameMatches) {
      names[match[1]] = match[2];
    }
    
    // Parse the hash map {13:"552027bd",59:"8a314126"}
    const hashMatches = hashMap.matchAll(/(\d+)\s*:\s*["']([^"']+)["']/g);
    const hashes = {};
    for (const match of hashMatches) {
      hashes[match[1]] = match[2];
    }
    
    // Generate all chunk URLs
    const allIds = new Set([...Object.keys(names), ...Object.keys(hashes)]);
    for (const id of allIds) {
      const chunkName = names[id] || id;
      const chunkHash = hashes[id];
      
      if (chunkHash) {
        // Store relative path with leading slash to prevent doubling
        const chunkPath = `/${basePath}${chunkName}${middlePart}${chunkHash}${extension}`;
        chunks.add(chunkPath);
      }
    }
  }
  
  // Pattern 2: Alternative webpack format with CSS - n.miniCssF = e => "path/" + {id: "hash"}[e] + ".chunk.css"
  const cssManifestPattern = /n\.miniCssF\s*=\s*e\s*=>\s*["']([^"']+)["']\s*\+\s*\{([^}]+)\}\[e\]\s*\+\s*["']([^"']+)["']/g;
  
  let cssMatch;
  while ((cssMatch = cssManifestPattern.exec(jsContent)) !== null) {
    const basePath = cssMatch[1];
    const hashMap = cssMatch[2];
    const extension = cssMatch[3];
    
    const hashMatches = hashMap.matchAll(/(\d+)\s*:\s*["']([^"']+)["']/g);
    for (const match of hashMatches) {
      const id = match[1];
      const hash = match[2];
      const chunkPath = `/${basePath}${id}.${hash}${extension}`;
      // Note: CSS chunks, but keeping for completeness
    }
  }
  
  // Pattern 3: Standard chunk patterns (fallback)
  const patterns = [
    // Webpack chunk loading: __webpack_require__.e, "chunkId":"filename"
    /"([^"]+\.chunk\.js)"/g,
    /'([^']+\.chunk\.js)'/g,
    // React/Vite chunks: import("./chunk-xxx.js")
    /import\(["']([^"']+\.js)["']\)/g,
    // Webpack manifest: {123:"chunk-name.js"}
    /["']([a-zA-Z0-9_-]+\.js)["']/g,
    // Static imports
    /src=["']([^"']+\.js)["']/g,
    /href=["']([^"']+\.js)["']/g,
    // Dynamic chunk patterns
    /\+["']([^"']+\.js)["']/g,
    // Webpack public path + chunk
    /\{[0-9]+:["']([^"']+\.js)["']\}/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(jsContent)) !== null) {
      let chunkPath = match[1];
      // Skip data URIs and external URLs
      if (chunkPath.startsWith('data:') || chunkPath.startsWith('http://') || chunkPath.startsWith('https://')) {
        continue;
      }
      // Add leading slash if not present to ensure proper URL resolution
      if (!chunkPath.startsWith('/')) {
        chunkPath = '/' + chunkPath;
      }
      chunks.add(chunkPath);
    }
  }

  return Array.from(chunks);
}

// Find main/runtime JS files that likely contain the chunk manifest
async function findMainJsFiles(page, baseUrl) {
  const scriptUrls = await page.evaluate(() => {
    const scripts = Array.from(document.querySelectorAll('script[src]'));
    return scripts.map(script => script.src);
  });

  console.log(scriptUrls);
  console.log(`Found ${scriptUrls.length} script tags on page`);
  
  // Prioritize main, runtime, vendor, app files
  const priorityKeywords = ['runtime', 'main', 'app', 'vendor', 'manifest', 'bundle'];
  
  const sortedScripts = scriptUrls.sort((a, b) => {
    const aScore = priorityKeywords.reduce((score, keyword) => 
      a.toLowerCase().includes(keyword) ? score + 1 : score, 0);
    const bScore = priorityKeywords.reduce((score, keyword) => 
      b.toLowerCase().includes(keyword) ? score + 1 : score, 0);
    return bScore - aScore;
  });

  return sortedScripts;
}

// Download and parse JS file to find chunk references
async function parseJsForChunks(jsUrl, baseUrl) {
  try {
    console.log(`Parsing JS file: ${jsUrl}`);
    const response = await axios.get(jsUrl, { 
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const content = response.data;
    const chunks = extractChunkReferences(content, baseUrl);
    
    console.log(`  Found ${chunks.length} potential chunks in ${jsUrl}`);
    
    // Resolve relative URLs
    const resolvedChunks = chunks.map(chunk => {
      try {
        return new URL(chunk, jsUrl).toString();
      } catch (e) {
        console.warn(`  Could not resolve chunk URL: ${chunk}`);
        return null;
      }
    }).filter(Boolean);
    
    return { url: jsUrl, content, chunks: resolvedChunks };
  } catch (error) {
    console.error(`  Error parsing ${jsUrl}: ${error.message}`);
    return { url: jsUrl, content: '', chunks: [] };
  }
}

// Process a single JS file and extract its source map
async function processJsFile(jsUrl, baseUrl, outputDir) {
  try {
    console.log(`Processing: ${jsUrl}`);
    const response = await axios.get(jsUrl, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const content = response.data;
    
    // Look for source map reference
    const sourceMapUrlMatch = content.match(/\/\*#\s*sourceMappingURL=(.+?)\s*\*\/|\/\/# sourceMappingURL=(.+?)(\n|$)/);
    
    if (!sourceMapUrlMatch) {
      console.warn(`  No source map reference found`);
      return;
    }
    
    const sourceMapPath = (sourceMapUrlMatch[1] || sourceMapUrlMatch[2]).trim();
    const sourceMapUrl = new URL(sourceMapPath, jsUrl).toString();
    
    console.log(`  Downloading source map: ${sourceMapUrl}`);
    const sourceMapResponse = await axios.get(sourceMapUrl, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const sourceMapData = sourceMapResponse.data;
    
    // Save the source map file
    const sourceMapFileName = path.basename(new URL(sourceMapUrl).pathname);
    const sourceMapFilePath = path.join(outputDir, 'sourcemaps', sourceMapFileName);
    await fs.mkdir(path.dirname(sourceMapFilePath), { recursive: true });
    await fs.writeFile(sourceMapFilePath, JSON.stringify(sourceMapData, null, 2));
    console.log(`  Saved source map: ${sourceMapFilePath}`);
    
    // Extract original sources from the source map
    const consumer = await new sourceMap.SourceMapConsumer(sourceMapData);
    const sources = consumer.sources;
    
    console.log(`  Extracting ${sources.length} source files`);
    
    for (const source of sources) {
      try {
        const sourceContent = consumer.sourceContentFor(source);
        if (sourceContent) {
          // Clean up the source path
          let cleanSource = source.replace(/^webpack:\/\/\//, '')
                                  .replace(/^\//, '')
                                  .replace(/\.\.\//g, '');
          
          const sourceFilePath = path.join(outputDir, 'sources', cleanSource);
          await fs.mkdir(path.dirname(sourceFilePath), { recursive: true });
          await fs.writeFile(sourceFilePath, sourceContent);
        }
      } catch (e) {
        console.warn(`    Could not extract source: ${source}`);
      }
    }
    
    consumer.destroy();
    
    // Save the compiled JS file
    const jsFileName = path.basename(new URL(jsUrl).pathname);
    const jsFilePath = path.join(outputDir, 'compiled', jsFileName);
    await fs.mkdir(path.dirname(jsFilePath), { recursive: true });
    await fs.writeFile(jsFilePath, content);
    
    console.log(`  ✓ Processed successfully`);
    
  } catch (error) {
    console.error(`  Error processing ${jsUrl}: ${error.message}`);
  }
}

async function downloadSourceMaps(websiteUrl, shouldRecord) {
  try {
    const baseUrl = new URL(websiteUrl);
    const outputDir = path.join('output', baseUrl.hostname);
    
    console.log('Starting browser...');
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    
    // Set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let recorder;
    if (shouldRecord) {
      const Config = {
        followNewTab: true,
        fps: 25,
        ffmpeg_Path: null,
        videoFrame: {
          width: 1920,
          height: 1080,
        },
      };

      await fs.mkdir('screenRecordings', { recursive: true });
      recorder = new PuppeteerScreenRecorder(page, Config);
      await recorder.start(`screenRecordings/screen-recording-${baseUrl.hostname}-${Date.now()}.mp4`);
      console.log('Screen recording started.');
    }

    // Collect all JS files loaded via network
    const networkJsFiles = new Set();
    page.on('response', async (response) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';
      if (contentType.includes('application/javascript') || 
          contentType.includes('text/javascript') ||
          url.endsWith('.js')) {
      //  networkJsFiles.add(url);
      }
    });

    console.log(`Navigating to ${websiteUrl}...`);
    const timeout = 30000;
    
    try {
      await page.goto(websiteUrl, { 
        timeout: timeout,
        waitUntil: 'networkidle2'
      });
    } catch (error) {
      console.warn(`Navigation issue: ${error.message}. Continuing...`);
    }

    // Wait for dynamic content
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log(`\nCollected ${networkJsFiles.size} JS files from network requests`);

    // Find main/runtime JS files
    console.log('\nFinding main JS files...');
    const mainJsFiles = await findMainJsFiles(page, baseUrl);
    //add mainJsFiles to networkJsFiles
    mainJsFiles.forEach(url => networkJsFiles.add(url));
    // Parse main files to find all chunks
    const allChunks = new Set();
    const parsedFiles = [];
    
    console.log('\nParsing main JS files for chunk references...');
    for (const jsUrl of mainJsFiles) { // Check top 10 files
      const parsed = await parseJsForChunks(jsUrl, baseUrl);
      parsedFiles.push(parsed);
      parsed.chunks.forEach(chunk => allChunks.add(chunk));
    }
    
    // Also add all network JS files
    networkJsFiles.forEach(url => allChunks.add(url));
    
    console.log(`\nTotal unique JS files to process: ${allChunks.size}`);
    
    if (shouldRecord) {
      await recorder.stop();
      console.log('Screen recording stopped.');
    }

    await browser.close();
    console.log('\nBrowser closed. Starting source map extraction...\n');
    
    // Process all JS files to extract source maps
    let processed = 0;
    for (const jsUrl of allChunks) {
      processed++;
      console.log(`\n[${processed}/${allChunks.size}] Processing JS file...`);
      await processJsFile(jsUrl, baseUrl, outputDir);
    }
    
    console.log(`\n✓ All source maps downloaded and extracted to: ${outputDir}`);
    console.log(`  - Source maps: ${outputDir}/sourcemaps`);
    console.log(`  - Original sources: ${outputDir}/sources`);
    console.log(`  - Compiled JS: ${outputDir}/compiled`);
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  }
}

function main() {
  const args = process.argv.slice(2);
  let websiteUrl;
  let shouldRecord = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && i + 1 < args.length) {
      websiteUrl = args[i + 1];
      i++;
    } else if (args[i] === '--record') {
      shouldRecord = true;
    }
  }

  if (!websiteUrl) {
    console.log('Usage: node index.js --url <website-url> [--record]');
    console.log('\nExamples:');
    console.log('  node index.js --url https://example.com');
    console.log('  node index.js --url https://react-app.com --record');
    process.exit(1);
  }

  if (!websiteUrl.startsWith('http://') && !websiteUrl.startsWith('https://')) {
    console.log('Please provide a full URL including the protocol (http:// or https://)');
    process.exit(1);
  }

  downloadSourceMaps(websiteUrl, shouldRecord);
}

main();