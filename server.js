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
    const { videos, audios, output_name } = req.body;
    console.log(`=== STARTING ===`);
    console.log(`Videos: ${videos ? videos.length : 0}`);

    // Clean up
    try {
      const oldFiles = fs.readdirSync(UPLOAD_DIR);
      oldFiles.forEach(f => fs.unlinkSync(path.join(UPLOAD_DIR, f)));
    } catch(e) {}

    const sceneFiles = [];

    // Process each scene
    for (let i = 0; i < videos.length; i++) {
      console.log(`\n--- Scene ${i+1} ---`);
      
      const videoPath = path.join(UPLOAD_DIR, `s${i+1}.mp4`);
      const audioPath = path.join(UPLOAD_DIR, `s${i+1}.mp3`);
      const outPath = path.join(UPLOAD_DIR, `out${i+1}.mp4`);

      try {
        // Write video
        let v64 = videos[i].includes('base64,') ? videos[i].split('base64,')[1] : videos[i];
        fs.writeFileSync(videoPath, Buffer.from(v64, 'base64'));
        console.log(`✓ Video: ${fs.statSync(videoPath).size}b`);

        // Write audio if exists
        if (audios && audios[i]) {
          fs.writeFileSync(audioPath, Buffer.from(audios[i], 'base64'));
          console.log(`✓ Audio: ${fs.statSync(audioPath).size}b`);
          
          // Merge video + audio
          const cmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -map 0:v -map 1:a -shortest "${outPath}"`;
          await execPromise(cmd).catch(() => {
            console.log('⚠️ Merge failed, copying video');
            fs.copyFileSync(videoPath, outPath);
          });
        } else {
          fs.copyFileSync(videoPath, outPath);
        }

        if (fs.existsSync(outPath)) {
          sceneFiles.push(outPath);
          console.log(`✓ Scene ${i+1} ready`);
        }

      } catch (e) {
        console.error(`Scene ${i+1} error:`, e.message);
        // Try to use what we have
        if (fs.existsSync(videoPath)) sceneFiles.push(videoPath);
      }
    }

    console.log(`\n--- Stitching ${sceneFiles.length} scenes ---`);

    // Create concat list
    const concatPath = path.join(UPLOAD_DIR, 'list.txt');
    const listContent = sceneFiles.map(f => `file '${f}'`).join('\n');
    fs.writeFileSync(concatPath, listContent);
    console.log('Concat list:', listContent);

    // Final output
    const outFile = path.join(OUTPUT_DIR, `${output_name || 'video'}.mp4`);
    
    // Try concat demuxer first
    try {
      const cmd = `ffmpeg -y -f concat -safe 0 -i "${concatPath}" -c copy "${outFile}"`;
      await execPromise(cmd);
      console.log('✓ Concat succeeded');
    } catch (e) {
      console.log('⚠️ Concat failed, trying concat protocol');
      // Fallback: use concat filter
      const inputs = sceneFiles.map(f => `-i "${f}"`).join(' ');
      const filter = sceneFiles.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('');
      const cmd = `ffmpeg -y ${inputs} ${filter} concat=n=${sceneFiles.length}:v=1:a=1 "${outFile}"`;
      await execPromise(cmd).catch(() => {
        console.log('⚠️ Filter concat failed, using first video only');
        fs.copyFileSync(sceneFiles[0], outFile);
      });
    }

    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) {
      const buffer = fs.readFileSync(outFile);
      console.log(`✓ Success: ${buffer.length}b`);
      res.json({ success: true, video: buffer.toString('base64') });
    } else {
      throw new Error('No output created');
    }

  } catch (error) {
    console.error('=== ERROR ===');
    console.error(error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg running`));
