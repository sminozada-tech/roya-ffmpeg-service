const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '200mb' }));

const UPLOAD_DIR = '/tmp/uploads';
const OUTPUT_DIR = '/tmp/output';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.post('/stitch', async (req, res) => {
  console.log('=== REQUEST RECEIVED ===');
  
  try {
    const { videos, audios, output_name } = req.body;
    
    if (!videos || videos.length === 0) {
      throw new Error('No videos provided');
    }

    console.log(`Processing ${videos.length} videos`);

    // Clean up
    try {
      fs.readdirSync(UPLOAD_DIR).forEach(f => fs.unlinkSync(path.join(UPLOAD_DIR, f)));
    } catch(e) {}

    const finalClips = [];

    // Process each clip
    for (let i = 0; i < videos.length; i++) {
      console.log(`\n--- Clip ${i+1} ---`);
      
      const vPath = path.join(UPLOAD_DIR, `v${i}.mp4`);
      const aPath = path.join(UPLOAD_DIR, `a${i}.mp3`);
      const outPath = path.join(UPLOAD_DIR, `out${i}.mp4`);

      try {
        // Write video
        const vData = videos[i].includes('base64,') ? videos[i].split('base64,')[1] : videos[i];
        fs.writeFileSync(vPath, Buffer.from(vData, 'base64'));
        const vSize = fs.statSync(vPath).size;
        console.log(`Video: ${vSize} bytes`);

        if (vSize < 1000) {
          console.log('⚠️ Video too small, skipping');
          continue;
        }

        // Try to merge with audio
        if (audios && audios[i]) {
          fs.writeFileSync(aPath, Buffer.from(audios[i], 'base64'));
          console.log(`Audio: ${fs.statSync(aPath).size} bytes`);
          
          try {
            await execAsync(`ffmpeg -y -i "${vPath}" -i "${aPath}" -c:v copy -c:a aac -map 0:v -map 1:a -shortest "${outPath}"`);
            console.log('✓ Merged with audio');
          } catch (e) {
            console.log('⚠️ Merge failed, using video only');
            fs.copyFileSync(vPath, outPath);
          }
        } else {
          fs.copyFileSync(vPath, outPath);
        }

        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
          finalClips.push(outPath);
          console.log(`✓ Clip ${i+1} ready`);
        }

      } catch (e) {
        console.error(`Clip ${i} error:`, e.message);
      }
    }

    console.log(`\n=== STITCHING ${finalClips.length} CLIPS ===`);

    if (finalClips.length === 0) {
      throw new Error('No valid clips to stitch');
    }

    // If only 1 clip, just return it
    if (finalClips.length === 1) {
      const buffer = fs.readFileSync(finalClips[0]);
      console.log(`✓ Single clip: ${buffer.length} bytes`);
      return res.json({ success: true, video: buffer.toString('base64') });
    }

    // Create concat file
    const concatPath = path.join(UPLOAD_DIR, 'concat.txt');
    const concatContent = finalClips.map(f => `file '${path.resolve(f)}'`).join('\n');
    fs.writeFileSync(concatPath, concatContent);
    console.log('Concat file:', concatContent);

    // Final output
    const outFile = path.join(OUTPUT_DIR, `${output_name || 'video'}.mp4`);
    
    // Try concat demuxer
    try {
      await execAsync(`ffmpeg -y -f concat -safe 0 -i "${concatPath}" -c copy "${outFile}"`);
      console.log('✓ Concat succeeded');
    } catch (e) {
      console.log('⚠️ Concat failed:', e.message);
      
      // Fallback: use first clip
      console.log('Using first clip as fallback');
      fs.copyFileSync(finalClips[0], outFile);
    }

    // Verify output
    if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1000) {
      console.log('⚠️ Output invalid, using first clip');
      fs.copyFileSync(finalClips[0], outFile);
    }

    const buffer = fs.readFileSync(outFile);
    console.log(`✓ Final video: ${buffer.length} bytes`);
    
    res.json({ success: true, video: buffer.toString('base64') });

  } catch (error) {
    console.error('=== ERROR ===');
    console.error(error.message);
    
    // Return error video (1 second black screen)
    try {
      const errorPath = path.join(OUTPUT_DIR, 'error.mp4');
      await execAsync(`ffmpeg -y -f lavfi -i color=c=black:s=720x1280:d=1 -c:v libx264 "${errorPath}"`);
      const buffer = fs.readFileSync(errorPath);
      res.json({ success: false, error: error.message, video: buffer.toString('base64') });
    } catch (e) {
      res.status(500).json({ error: error.message });
    }
  }
});

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    console.log('Running:', cmd);
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error('FFmpeg error:', stderr);
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg service running on port ${PORT}`));
