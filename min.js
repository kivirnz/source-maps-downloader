const fs = require('fs');
const path = require('path');
const fetch = require('axios');
const readline = require('readline');
const { SourceMapConsumer } = require('source-map');

async function fetchAndRestructureSourceMap(mapUrl) {
    try {
        // Fetch the source map file from the provided URL
        console.log(`Fetching source map from: ${mapUrl}`);
        const response = await fetch(mapUrl);
        
        const mapContent = await response.data;
        const consumer = await new SourceMapConsumer(mapContent);

        // Process and save each source file
        consumer.sources.forEach((source) => {
            console.log(`Original Source: ${source}`);

            // Get the source content from the source map
            const sourceContent = consumer.sourceContentFor(source);
            if (sourceContent) {
                // Normalize the source path
                const normalizedSource = source.replace(/^webpack:\/\//, '').replace(/\.\.\//g, '');
                const outputFilePath = path.join('./output', normalizedSource);

                // Create directories recursively if they don't exist
                fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });

                // Write the source content to the normalized path
                fs.writeFileSync(outputFilePath, sourceContent, 'utf8');
                console.log(`Saved: ${outputFilePath}`);
            }
        });

        consumer.destroy();
        console.log('Source map processed successfully.');
    } catch (error) {
        console.error(`Error processing source map: ${error.message}`);
    }
}

function askUserForUrl() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.question('Enter the URL of the source map: ', (url) => {
        if (!url) {
            console.error('No URL provided. Exiting...');
            rl.close();
            return;
        }

        fetchAndRestructureSourceMap(url)
            .then(() => rl.close())
            .catch((error) => {
                console.error(`Failed to process the source map: ${error.message}`);
                rl.close();
            });
    });
}

// Start the process by asking for the URL
askUserForUrl();
