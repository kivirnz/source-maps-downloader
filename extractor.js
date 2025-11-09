
async function extractChunkReferences(content) {
  const chunks = new Set();

  // Pattern 1: n.u=e=>"static/js/"+({...}[e]||e)+"."+{...}[e]+".chunk.js"
  const pattern1 = /n\.u\s*=\s*e\s*=>\s*"([^"]+)"\s*\+\s*\((\{[^}]+\})\[e\]\|\|e\)\s*\+\s*"([^"]+)"\s*\+\s*(\{[^}]+\})\[e\]\s*\+\s*"([^"]+)"/;
  
  // Pattern 2: u=e=>({...}[e]+".c.js")
  const pattern2 = /\.u\s*=\s*e\s*=>\s*\(?\s*(\{[^}]+\})\[e\]\s*\+\s*"([^"]+)"\s*\)?/;
  
  // Pattern 3: n.u=e=>"path/"+e+"."+{...}[e]+".js"
  const pattern3 = /n\.u\s*=\s*e\s*=>\s*"([^"]+)"\s*\+\s*e\s*\+\s*"([^"]+)"\s*\+\s*(\{[^}]+\})\[e\]\s*\+\s*"([^"]+)"/;
  
  // Pattern 4: Simple object with extension - u=e=>({...}[e]+"ext")
  const pattern4 = /\.u\s*=\s*e\s*=>\s*\(?(\{[^}]+\})\[e\]\s*\+\s*"([^"]+)"\)?/;

  let match;
  let patternType;

  if ((match = content.match(pattern1))) {
    patternType = 1;
    console.log('Matched Pattern 1: Full webpack pattern with names and hashes');
    return parsePattern1(match, chunks);
  } else if ((match = content.match(pattern2))) {
    patternType = 2;
    console.log('Matched Pattern 2: Simple hash object pattern');
    return parsePattern2(match, chunks);
  } else if ((match = content.match(pattern3))) {
    patternType = 3;
    console.log('Matched Pattern 3: Path + id + hash pattern');
    return parsePattern3(match, chunks);
  } else if ((match = content.match(pattern4))) {
    patternType = 4;
    console.log('Matched Pattern 4: Direct hash + extension');
    return parsePattern4(match, chunks);
  } else {
    console.log('No known pattern matched');
    
    // Fallback: Find any .u= assignment and try to extract objects
    const fallbackMatch = content.match(/\.u\s*=\s*e\s*=>\s*[^;,]{10,500}[;,]/);
    if (fallbackMatch) {
      console.log('Found .u assignment, attempting generic parse...');
      console.log('Assignment:', fallbackMatch[0]);
      return parseGeneric(fallbackMatch[0], chunks);
    }
  }

  return chunks;
}

function parsePattern1(match, chunks) {
  // Pattern: "static/js/"+({102:"xlsx"}[e]||e)+"."+{102:"d55488e0"}[e]+".chunk.js"
  const [, basePath, namesObjStr, midStr, hashesObjStr, extension] = match;
  
  console.log('Base path:', basePath);
  console.log('Middle string:', midStr);
  console.log('Extension:', extension);
  
  const nameMap = parseObject(namesObjStr);
  const hashMap = parseObject(hashesObjStr);
  
  console.log('Names found:', Object.keys(nameMap).length);
  console.log('Hashes found:', Object.keys(hashMap).length);

  const allIds = new Set([...Object.keys(nameMap), ...Object.keys(hashMap)]);

  for (const id of allIds) {
    const name = nameMap[id] || '';
    const hash = hashMap[id] || '';
    
    let filename;
    if (name) {
      filename = `${name}${midStr}${hash}`;
    } else {
      filename = `${id}${midStr}${hash}`;
    }
    
    const chunkPath = `/${basePath}${filename}${extension}`;
    chunks.add(chunkPath);
  }

  return chunks;
}

function parsePattern2(match, chunks) {
  // Pattern: u=e=>({29:"4618cca8a574facf2276"}[e]+".c.js")
  const [, objStr, extension] = match;
  
  console.log('Extension:', extension);
  
  const hashMap = parseObject(objStr);
  console.log('Chunks found:', Object.keys(hashMap).length);

  for (const [id, hash] of Object.entries(hashMap)) {
    const filename = `${hash}${extension}`;
    chunks.add(filename);
  }

  return chunks;
}

function parsePattern3(match, chunks) {
  // Pattern: "path/"+e+"."+{...}[e]+".js"
  const [, basePath, midStr, hashesObjStr, extension] = match;
  
  const hashMap = parseObject(hashesObjStr);
  
  for (const [id, hash] of Object.entries(hashMap)) {
    const filename = `${id}${midStr}${hash}`;
    const chunkPath = `${basePath}${filename}${extension}`;
    chunks.add(chunkPath);
  }

  return chunks;
}

function parsePattern4(match, chunks) {
  // Pattern: u=e=>({...}[e]+"ext")
  const [, objStr, extension] = match;
  
  const map = parseObject(objStr);
  
  for (const [id, value] of Object.entries(map)) {
    chunks.add(`${value}${extension}`);
  }

  return { chunks };
}

function parseGeneric(assignment, chunks) {
  // Extract all objects from the assignment
  const objects = extractObjects(assignment);
  
  if (objects.length === 0) {
    console.log('No objects found in assignment');
    return { chunks };
  }
  
  // Extract all string literals
  const strings = [...assignment.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  console.log('String literals:', strings);
  
  // Parse all objects
  const allMaps = objects.map(obj => parseObject(obj));
  
  // Try to build chunks from the data
  for (const map of allMaps) {
    for (const [id, value] of Object.entries(map)) {
      // If value looks like a hash, create chunk
      if (/^[a-f0-9]{8,}$/i.test(value)) {
        chunks.add(`${value}.js`);
      }
    }
  }
  
  return { chunks };
}

function parseObject(objStr) {
  const map = {};
  const entries = [...objStr.matchAll(/(\d+):"([^"]+)"/g)];
  for (const [, id, value] of entries) {
    map[id] = value;
  }
  return map;
}

function extractObjects(str) {
  const objects = [];
  let depth = 0;
  let start = -1;
  
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (str[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(str.substring(start, i + 1));
        start = -1;
      }
    }
  }
  
  return objects;
}

export { extractChunkReferences };
