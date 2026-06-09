const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();
app.use(express.json({ limit: '100mb' }));

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
    console.log(`Subtitles: ${subtitles ? subtitles.length : 0}`);

    // Clean up old files
    const oldFiles = fs.readdirSync(UPLOAD_DIR);
    oldFiles.forEach(file => {
      const filePath = path.join(UPLOAD_DIR, file);
      fs.unlinkSync(filePath);
      console.log(`Deleted old file: ${file}`);
    });

    const mergedPaths = [];

    // Process each scene
    for (let i = 0; i < videos.length; i++) {
      console.log(`\n=== Processing Scene ${i + 1} ===`);
      
      const videoPath = path.join(UPLOAD_DIR, `scene${i+1}.mp4`);
      const audioPath = path.join(UPLOAD_DIR, `scene${i+1}.mp3`);
      const mergedPath = path.join(UPLOAD_DIR, `merged${i+1}.mp4`);

      try {
        // Write video file
        const videoData = videos[i].replace(/^data:video\/mp4;base64,/, '');
        fs.writeFileSync(videoPath, Buffer.from(videoData, 'base64'));
        console.log(`✓ Video written: ${videoPath}`);

        // Check if we have audio
        let hasAudio = false;
        if (audios && audios[i]) {
          fs.writeFileSync(audioPath, Buffer.from(audios[i], 'base64'));
          hasAudio = true;
          console.log(`✓ Audio written: ${audioPath}`);
        }

        // Build FFmpeg command
        let cmd;
        if (hasAudio) {
          // Merge video + audio
          cmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -map 0:v -map 1:a -shortest "${mergedPath}"`;
        } else {
          // Just copy video (no audio)
          cmd = `ffmpeg -y -i "${videoPath}" -c copy -an "${mergedPath}"`;
        }

        console.log(`Running: ${cmd}`);
        
        try {
          await execPromise(cmd);
          console.log(`✓ Merge successful: ${mergedPath}`);
          
          // Verify file exists
          if (fs.existsSync(mergedPath)) {
            const stats = fs.statSync(mergedPath);
            console.log(`✓ File size: ${stats.size} bytes`);
            mergedPaths.push(mergedPath);
          } else {
            throw new Error(`Merged file not found: ${mergedPath}`);
          }
        } catch (ffmpegError) {
          console.error(`FFmpeg error:`, ffmpegError.stderr || ffmpegError.message);
          // Fallback: use original video
          console.log(`⚠️ Using original video as fallback`);
          fs.copyFileSync(videoPath, mergedPath);
          mergedPaths.push(mergedPath);
        }

      } catch (sceneError) {
        console.error(`Scene ${i+1} failed:`, sceneError.message);
        // Still add to mergedPaths so we don't break the concat
        if (fs.existsSync(videoPath)) {
          mergedPaths.push(videoPath);
        }
      }
    }

    console.log(`\n=== Creating Concat File ===`);
    const concatFile = path.join(UPLOAD_DIR, 'concat.txt');
    const concatContent = mergedPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);
    console.log(`Concat file content:\n${concatContent}`);

    // Stitch all scenes
    console.log(`\n=== Stitching Scenes ===`);
    const outputFileName = (output_name || 'stitched-video').replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputPath = path.join(OUTPUT_DIR, `${outputFileName}.mp4`);
    
    const stitchCmd = `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${outputPath}"`;
    console.log(`Running: ${stitchCmd}`);
    
    await execPromise(stitchCmd);
    console.log(`✓ Final video created: ${outputPath}`);

    // Verify output
    if (!fs.existsSync(outputPath)) {
      throw new Error('Final output file not created');
    }

    const videoBuffer = fs.readFileSync(outputPath);
    console.log(`✓ Video size: ${videoBuffer.length} bytes`);
    
    res.json({ 
      success: true, 
      video: videoBuffer.toString('base64'), 
      filename: `${outputFileName}.mp4`,
      debug: {
        scenesProcessed: mergedPaths.length,
        totalSize: videoBuffer.length
      }
    });

  } catch (error) {
    console.error(`\n=== FINAL ERROR ===`);
    console.error(error);
    res.status(500).json({ 
      error: error.message,
      stack: error.stack
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg service running on port ${PORT}`));
