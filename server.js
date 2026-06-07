const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '50mb' }));

const UPLOAD_DIR = '/tmp/uploads';
const OUTPUT_DIR = '/tmp/output';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.post('/stitch', async (req, res) => {
  try {
    const { videos, output_name } = req.body;
    
    console.log(`Received ${videos.length} videos to stitch`);
    
    const videoPaths = [];
    for (let i = 0; i < videos.length; i++) {
      const videoUrl = videos[i];
      const localPath = path.join(UPLOAD_DIR, `scene${i + 1}.mp4`);
      
      console.log(`Downloading video ${i + 1}...`);
      const response = await axios({
        url: videoUrl,
        method: 'GET',
        responseType: 'stream'
      });
      
      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(localPath);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      
      videoPaths.push(localPath);
    }
    
    const concatFile = path.join(UPLOAD_DIR, 'concat.txt');
    const concatContent = videoPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);
    
    const outputPath = path.join(OUTPUT_DIR, `${output_name || 'stitched'}.mp4`);
    const ffmpegCmd = `ffmpeg -f concat -safe 0 -i ${concatFile} -c copy ${outputPath}`;
    
    console.log('Running FFmpeg...');
    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error, stdout, stderr) => {
        if (error) {
          console.error('FFmpeg error:', stderr);
          reject(error);
        } else {
          console.log('FFmpeg complete:', stdout);
          resolve();
        }
      });
    });
    
    const videoBuffer = fs.readFileSync(outputPath);
    const base64Video = videoBuffer.toString('base64');
    
    videoPaths.forEach(p => fs.unlinkSync(p));
    fs.unlinkSync(concatFile);
    fs.unlinkSync(outputPath);
    
    console.log('Sending stitched video...');
    
    res.json({
      success: true,
      video: base64Video,
      filename: `${output_name || 'stitched'}.mp4`
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FFmpeg service running on port ${PORT}`);
});
