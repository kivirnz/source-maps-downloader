import https from 'https';

import { extractChunkReferences } from './extractor.js';
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Run test
const testUrls = [
  'https://dofia.net/24018a2440178dbdbbf5.b.js',
  // Add your second URL here for testing
];

for (const url of testUrls) {
  console.log('\n' + '='.repeat(80));
  console.log(`Testing URL: ${url}`);
  extractChunkReferences(await fetchText(url))
    .then(result => {
      console.log(`\nFound ${result.size} chunks:`);
      const sorted = [...result].sort();
      sorted.forEach(chunk => console.log(chunk));
    })
    .catch(console.error);
}