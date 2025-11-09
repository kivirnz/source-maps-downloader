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
  
  // Pattern 1: Webpack/Dynamic chunk manifest - n.u = e => ... pattern
  // Matches: n.u = e => "path/" + ({id:"name"}[e]||e) + "." + {id:"hash"}[e] + ".ext"
  // Also matches simpler variants like: n.u = e => "path/" + e + ".hash.ext"
  const dynamicChunkPattern = /(?:n\.u|[a-z]\.u|u)\s*=\s*(?:function\s*)?\(?e\)?\s*=>\s*{?[^}]*?["']([^"']+)["'][^}]*?}/g;
  
  let dynamicMatch;
  while ((dynamicMatch = dynamicChunkPattern.exec(jsContent)) !== null) {
    const chunkDefinition = dynamicMatch[0];
    
    // Extract base path
    const basePathMatch = chunkDefinition.match(/["']([^"']*\/[^"']*?)["']/);
    let basePath = basePathMatch ? basePathMatch[1] : '';
    
    // Extract all object literals with id:value mappings
    const objectLiterals = chunkDefinition.matchAll(/\{([^}]+)\}/g);
    const allMappings = [];
    
    for (const literal of objectLiterals) {
      const content = literal[1];
      const mappings = content.matchAll(/(\d+)\s*:\s*["']([^"']+)["']/g);
      
      for (const mapping of mappings) {
        allMappings.push({
          id: mapping[1],
          value: mapping[2]
        });
      }
    }
    
    // Group by ID to combine name and hash
    const chunksById = {};
    for (const mapping of allMappings) {
      if (!chunksById[mapping.id]) {
        chunksById[mapping.id] = {};
      }
      // Determine if this is a name or hash based on content
      if (mapping.value.length <= 10 && /^[a-f0-9]+$/i.test(mapping.value)) {
        chunksById[mapping.id].hash = mapping.value;
      } else {
        chunksById[mapping.id].name = mapping.value;
      }
    }
    
    // Extract extension from the pattern
    const extensionMatch = chunkDefinition.match(/["'](\.chunk\.js|\.js|\.mjs)["']/);
    const extension = extensionMatch ? extensionMatch[1] : '.chunk.js';
    
// Build chunk URLs
for (const [id, data] of Object.entries(chunksById)) {
  const { name = '', hash = '' } = data;

  // Compose filename parts dynamically, skipping empty ones
  const parts = [id, name, hash].filter(Boolean);
  const filename = parts.join('.');

  // Ensure basePath ends with '/'
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;

  // Build final chunk path
  const chunkPath = `${normalizedBase}${filename}${extension}`;

  chunks.add(chunkPath);
}
  }
  
  // Pattern 2: CSS chunk manifest
  const cssPattern = /(?:miniCssF|cssF)\s*=\s*(?:function\s*)?\(?e\)?\s*=>\s*{?[^}]*?["']([^"']+)["'][^}]*?}/g;
  
  let cssMatch;
  while ((cssMatch = cssPattern.exec(jsContent)) !== null) {
    const cssDefinition = cssMatch[0];
    
    const basePathMatch = cssDefinition.match(/["']([^"']*\/[^"']*?)["']/);
    const basePath = basePathMatch ? basePathMatch[1] : '';
    
    const mappings = cssDefinition.matchAll(/(\d+)\s*:\s*["']([^"']+)["']/g);
    
    for (const mapping of mappings) {
      const id = mapping[1];
      const hash = mapping[2];
      const chunkPath = `/${basePath}${id}.${hash}.chunk.css`;
      // CSS chunks noted but not added to JS chunks
    }
  }
  
  // Pattern 3: Direct string references to chunk files
  const directPatterns = [
    // Quoted chunk references
    /["']([^"']*?\.chunk\.js)["']/g,
    /["']([^"']*?\/\d+\.[a-f0-9]+\.chunk\.js)["']/g,
    // Import statements
    /import\s*\(\s*["']([^"']+\.js)["']\s*\)/g,
    // Webpack require
    /__webpack_require__\.e\([^)]*\)\.then[^"']*["']([^"']+)["']/g,
  ];
  
  for (const pattern of directPatterns) {
    let match;
    while ((match = pattern.exec(jsContent)) !== null) {
      let chunkPath = match[1];
      
      // Skip external URLs and data URIs
      if (chunkPath.startsWith('data:') || 
          chunkPath.startsWith('http://') || 
          chunkPath.startsWith('https://') ||
          chunkPath.startsWith('//')) {
        continue;
      }
      
      // Skip if it's just a variable or doesn't look like a real path
      if (!chunkPath.includes('/') && !chunkPath.match(/\d+\.[a-f0-9]+\.chunk\.js/)) {
        continue;
      }
      
      // Ensure leading slash for absolute resolution
      if (!chunkPath.startsWith('/')) {
        chunkPath = '/' + chunkPath;
      }
      
      chunks.add(chunkPath);
    }
  }
  
  // Pattern 4: Numeric references that might be chunk IDs
  // Look for patterns like: 123:"hash" or {123:"filename"}
  const chunkIdPattern = /["'](static\/js\/|assets\/|js\/|chunks\/)?(\d+)\.([a-f0-9]{8,})\.chunk\.js["']/g;
  
  let idMatch;
  while ((idMatch = chunkIdPattern.exec(jsContent)) !== null) {
    const fullPath = idMatch[0].replace(/["']/g, '');
    chunks.add('/' + fullPath);
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