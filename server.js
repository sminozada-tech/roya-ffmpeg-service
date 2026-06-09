const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
app.use(express.json({ limit: '150mb' }));

const UPLOAD_DIR = '/tmp/uploads';
const OUTPUT_DIR = '/tmp/output';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.post('/stitch', async (req, res) => {
  try {
    const { videos, audios, subtitles, output_name } = req.body;
    console.log(`=== STARTING PROCESS ===`);
    console.log(`Videos: ${videos ? videos.length : 0}`);
    console.log(`Audios: ${audios ? audios.length : 0}`);

    // Clean up
    const oldFiles = fs.readdirSync(UPLOAD_DIR);
    oldFiles.forEach(file => fs.unlinkSync(path.join(UPLOAD_DIR, file)));

    const finalPaths = [];

    for (let i = 0; i < videos.length; i++) {
      console.log(`\n=== Scene ${i + 1} ===`);
      
      const videoPath = path.join(UPLOAD_DIR, `scene${i+1}.mp4`);
      const audioPath = path.join(UPLOAD_DIR, `scene${i+1}.mp3`);
      const outputPath = path.join(UPLOAD_DIR, `final${i+1}.mp4`);

      try {
        // Write video - handle both with and without data: prefix
        let videoBase64 = videos[i];
        if (videoBase64.includes('base64,')) {
          videoBase64 = videoBase64.split('base64,')[1];
        }
        fs.writeFileSync(videoPath, Buffer.from(videoBase64, 'base64'));
        console.log(`✓ Video written (${fs.statSync(videoPath).size} bytes)`);

        // Check if video is valid
        try {
          await execPromise(`ffmpeg -y -i "${videoPath}" -f null - 2>&1 | head -20`);
          console.log('✓ Video is valid');
        } catch (e) {
          console.log('⚠️ Video might be corrupted, continuing anyway...');
        }

        // Write audio if exists
        let hasAudio = false;
        if (audios && audios[i]) {
          fs.writeFileSync(audioPath, Buffer.from(audios[i], 'base64'));
          hasAudio = true;
          console.log(`✓ Audio written (${fs.statSync(audioPath).size} bytes)`);
        }

        // Merge video + audio (skip subtitles for now - they're causing issues)
        let cmd;
        if (hasAudio) {
          cmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -map 0:v -map 1:a -shortest "${outputPath}"`;
        } else {
          cmd = `ffmpeg -y -i "${videoPath}" -c copy -an "${outputPath}"`;
        }

        console.log(`Running: ${cmd}`);
        await execPromise(cmd);
        console.log(`✓ Merge complete`);
        
        finalPaths.push(outputPath);

      } catch (error) {
        console.error(`Scene ${i+1} error:`, error.message);
        // Use original video as fallback
        if (fs.existsSync(videoPath)) {
          finalPaths.push(videoPath);
        }
      }
    }

    // Create concat file
    const concatFile = path.join(UPLOAD_DIR, 'concat.txt');
    const concatContent = finalPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);
    console.log(`\nConcat file:\n${concatContent}`);

    // Stitch all
    const outputFileName = (output_name || 'stitched-video').replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputPath = path.join(OUTPUT_DIR, `${outputFileName}.mp4`);
    
    const stitchCmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${outputPath}"`;
    console.log(`\nStitching: ${stitchCmd}`);
    await execPromise(stitchCmd);

    const videoBuffer = fs.readFileSync(outputPath);
    console.log(`✓ Final video: ${videoBuffer.length} bytes`);
    
    res.json({ 
      success: true, 
      video: videoBuffer.toString('base64'), 
      filename: `${outputFileName}.mp4`
    });

  } catch (error) {
    console.error('=== FINAL ERROR ===');
    console.error(error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg service running`));
