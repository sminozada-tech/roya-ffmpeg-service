const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
app.use(express.json({ limit: '200mb' }));

const UPLOAD_DIR = '/tmp/uploads';
const OUTPUT_DIR = '/tmp/output';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.post('/stitch', async (req, res) => {
  try {
    const { videos, audios, subtitles, output_name } = req.body;
    console.log(`=== STARTING PROCESS ===`);
    console.log(`Videos received: ${videos ? videos.length : 0}`);

    // Clean up
    const oldFiles = fs.readdirSync(UPLOAD_DIR);
    oldFiles.forEach(file => fs.unlinkSync(path.join(UPLOAD_DIR, file)));

    const finalPaths = [];

    for (let i = 0; i < videos.length; i++) {
      console.log(`\n=== Processing Scene ${i + 1} ===`);
      
      const videoPath = path.join(UPLOAD_DIR, `scene${i+1}.mp4`);
      const audioPath = path.join(UPLOAD_DIR, `scene${i+1}.mp3`);
      const fixedPath = path.join(UPLOAD_DIR, `fixed${i+1}.mp4`);
      const finalPath = path.join(UPLOAD_DIR, `final${i+1}.mp4`);

      try {
        // Write video
        let videoBase64 = videos[i];
        if (videoBase64.includes('base64,')) {
          videoBase64 = videoBase64.split('base64,')[1];
        }
        fs.writeFileSync(videoPath, Buffer.from(videoBase64, 'base64'));
        const videoSize = fs.statSync(videoPath).size;
        console.log(`Video written: ${videoSize} bytes`);

        // Try to fix corrupted video
        try {
          console.log('Attempting to fix video...');
          const fixCmd = `ffmpeg -y -i "${videoPath}" -c copy -movflags +faststart "${fixedPath}" 2>&1`;
          await execPromise(fixCmd);
          
          if (fs.existsSync(fixedPath) && fs.statSync(fixedPath).size > 0) {
            console.log('✓ Video fixed successfully');
          } else {
            console.log('⚠️ Fix failed, using original');
            fs.copyFileSync(videoPath, fixedPath);
          }
        } catch (e) {
          console.log('⚠️ Video might be corrupted, continuing...');
          fs.copyFileSync(videoPath, fixedPath);
        }

        // Write audio if exists
        let hasAudio = false;
        if (audios && audios[i]) {
          fs.writeFileSync(audioPath, Buffer.from(audios[i], 'base64'));
          hasAudio = true;
          console.log(`✓ Audio written: ${fs.statSync(audioPath).size} bytes`);
        }

        // Merge video + audio with error recovery
        let mergeCmd;
        if (hasAudio) {
          // Try to merge, ignore errors
          mergeCmd = `ffmpeg -y -i "${fixedPath}" -i "${audioPath}" -c:v copy -c:a aac -map 0:v -map 1:a -shortest "${finalPath}" 2>&1 || cp "${fixedPath}" "${finalPath}"`;
        } else {
          mergeCmd = `cp "${fixedPath}" "${finalPath}"`;
        }

        console.log('Merging...');
        await execPromise(mergeCmd);
        
        if (fs.existsSync(finalPath)) {
          console.log(`✓ Final scene ${i+1}: ${fs.statSync(finalPath).size} bytes`);
          finalPaths.push(finalPath);
        } else {
          console.log('⚠️ Final file not created, using fixed version');
          finalPaths.push(fixedPath);
        }

      } catch (error) {
        console.error(`Scene ${i+1} failed:`, error.message);
        // Try to use whatever we have
        if (fs.existsSync(fixedPath)) {
          finalPaths.push(fixedPath);
        } else if (fs.existsSync(videoPath)) {
          finalPaths.push(videoPath);
        }
      }
    }

    console.log(`\n=== Stitching ${finalPaths.length} scenes ===`);
    
    // Create concat file
    const concatFile = path.join(UPLOAD_DIR, 'concat.txt');
    const concatContent = finalPaths.map(p => `file '${path.resolve(p)}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);
    console.log(`Concat file:\n${concatContent}`);

    // Stitch all scenes
    const outputFileName = (output_name || 'stitched-video').replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputPath = path.join(OUTPUT_DIR, `${outputFileName}.mp4`);
    
    const stitchCmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${outputPath}" 2>&1 || echo "Stitch failed"`;
    await execPromise(stitchCmd);

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      const videoBuffer = fs.readFileSync(outputPath);
      console.log(`✓ Success: ${videoBuffer.length} bytes`);
      
      res.json({ 
        success: true, 
        video: videoBuffer.toString('base64'), 
        filename: `${outputFileName}.mp4`
      });
    } else {
      throw new Error('No output video created');
    }

  } catch (error) {
    console.error('=== FINAL ERROR ===');
    console.error(error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg service running`));
