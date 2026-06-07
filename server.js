const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '100mb' })); // Increased for larger videos

const UPLOAD_DIR = '/tmp/uploads';
const OUTPUT_DIR = '/tmp/output';

// Create directories
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.post('/stitch', async (req, res) => {
  try {
    const { videos, output_name } = req.body;
    
    console.log(`Received ${videos.length} videos to stitch`);
    
    // Clean up old files
    const oldFiles = fs.readdirSync(UPLOAD_DIR);
    oldFiles.forEach(file => {
      fs.unlinkSync(path.join(UPLOAD_DIR, file));
    });
    
    const videoPaths = [];
    
    // Write each video
    for (let i = 0; i < videos.length; i++) {
      const base64Data = videos[i];
      const fileName = `scene${i + 1}.mp4`;
      const filePath = path.join(UPLOAD_DIR, fileName);
      
      console.log(`Writing video ${i + 1} to ${fileName}...`);
      
      // Remove data URL prefix if present
      const cleanBase64 = base64Data.replace(/^data:video\/mp4;base64,/, '');
      
      // Write binary data
      const buffer = Buffer.from(cleanBase64, 'base64');
      fs.writeFileSync(filePath, buffer);
      
      // Verify file was written
      const stats = fs.statSync(filePath);
      console.log(`File size: ${stats.size} bytes`);
      
      if (stats.size === 0) {
        throw new Error(`Video ${i + 1} is empty!`);
      }
      
      videoPaths.push(filePath);
    }
    
    // Create concat file with proper formatting
    const concatFile = path.join(UPLOAD_DIR, 'concat.txt');
    const concatContent = videoPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);
    
    console.log('Concat file content:');
    console.log(fs.readFileSync(concatFile, 'utf8'));
    
    // Stitch videos
    const outputFileName = (output_name || 'stitched-video').replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputPath = path.join(OUTPUT_DIR, `${outputFileName}.mp4`);
    
    const ffmpegCmd = `ffmpeg -y -f concat -safe 0 -i ${concatFile} -c copy ${outputPath}`;
    
    console.log('Running FFmpeg...');
    console.log('Command:', ffmpegCmd);
    
    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error, stdout, stderr) => {
        if (error) {
          console.error('FFmpeg error:', stderr);
          reject(error);
        } else {
          console.log('FFmpeg stdout:', stdout);
          console.log('FFmpeg stderr:', stderr);
          resolve();
        }
      });
    });
    
    // Read output
    const videoBuffer = fs.readFileSync(outputPath);
    const base64Video = videoBuffer.toString('base64');
    
    console.log(`Stitched video size: ${videoBuffer.length} bytes`);
    
    // Clean up
    videoPaths.forEach(p => {
      try { fs.unlinkSync(p); } catch(e) {}
    });
    try { fs.unlinkSync(concatFile); } catch(e) {}
    try { fs.unlinkSync(outputPath); } catch(e) {}
    
    res.json({
      success: true,
      video: base64Video,
      filename: `${outputFileName}.mp4`
    });
    
  } catch (error) {
    console.error('Stitch error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FFmpeg service running on port ${PORT}`);
});
