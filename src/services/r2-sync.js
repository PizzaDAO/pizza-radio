const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const SONGS_DIR = path.join(__dirname, '../../songs');

async function syncSongsFromR2() {
    const { R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME } = process.env;

    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME) {
        console.log('R2 env vars not set, skipping sync (using local songs/)');
        return;
    }

    const client = new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
    });

    console.log('Starting R2 sync...');
    fs.mkdirSync(SONGS_DIR, { recursive: true });

    let totalFiles = 0;
    let continuationToken;

    do {
        const listCmd = new ListObjectsV2Command({
            Bucket: R2_BUCKET_NAME,
            ContinuationToken: continuationToken,
        });
        const listRes = await client.send(listCmd);

        for (const obj of listRes.Contents || []) {
            // Skip "directory" markers
            if (obj.Key.endsWith('/')) continue;

            const localPath = path.join(SONGS_DIR, obj.Key);
            fs.mkdirSync(path.dirname(localPath), { recursive: true });

            const getCmd = new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: obj.Key });
            const getRes = await client.send(getCmd);
            await pipeline(getRes.Body, fs.createWriteStream(localPath));
            totalFiles++;
        }

        continuationToken = listRes.NextContinuationToken;
    } while (continuationToken);

    console.log(`R2 sync complete: ${totalFiles} files downloaded`);
}

module.exports = { syncSongsFromR2 };
