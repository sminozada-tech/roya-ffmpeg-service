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
  try {
    const { videos, audios, output_name } = req.body;

    console.log(`Received ${videos.length} videos, ${audios ? audios.length : 0} audios`);

    // Clean up old files
    fs.readdirSync(UPLOAD_DIR).forEach(file => {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, file)); } catch(e) {}
    });

    const finalScenePaths = [];

    for (let i = 0; i < videos.length; i++) {
      // Write video
      const videoPath = path.join(UPLOAD_DIR, `scene${i + 1}_raw.mp4`);
      const cleanVideo = videos[i].replace(/^data:video\/mp4;base64,/, '');
      fs.writeFileSync(videoPath, Buffer.from(cleanVideo, 'base64'));

      const videoStats = fs.statSync(videoPath);
      console.log(`Video ${i + 1} size: ${videoStats.size} bytes`);
      if (videoStats.size === 0) throw new Error(`Video ${i + 1} is empty!`);

      // If audio provided, merge audio onto video
      if (audios && audios[i]) {
        const audioPath = path.join(UPLOAD_DIR, `scene${i + 1}_audio.mp3`);
        const cleanAudio = audios[i].replace(/^data:audio\/mp3;base64,/, '').replace(/^data:audio\/mpeg;base64,/, '');
        fs.writeFileSync(audioPath, Buffer.from(cleanAudio, 'base64'));

        const audioStats = fs.statSync(audioPath);
        console.log(`Audio ${i + 1} size: ${audioStats.size} bytes`);

        const mergedPath = path.join(UPLOAD_DIR, `scene${i + 1}_merged.mp4`);

        // Merge video + audio, use video length as duration
        await new Promise((resolve, reject) => {
          const cmd = `ffmpeg -y -i ${videoPath} -i ${audioPath} -map 0:v -map 1:a -c:v copy -c:a aac -shortest ${mergedPath}`;
          console.log(`Merging scene ${i + 1}:`, cmd);
          exec(cmd, (error, stdout, stderr) => {
            if (error) {
              console.error(`Merge error scene ${i + 1}:`, stderr);
              reject(error);
            } else {
              resolve();
            }
          });
        });

        finalScenePaths.push(mergedPath);
      } else {
        // No audio — use raw video
        finalScenePaths.push(videoPath);
      }
    }

    // Stitch all scenes together
    const concatFile = path.join(UPLOAD_DIR, 'concat.txt');
    fs.writeFileSync(concatFile, finalScenePaths.map(p => `file '${p}'`).join('\n'));

    console.log('Concat file:', fs.readFileSync(concatFile, 'utf8'));

    const outputFileName = (output_name || 'stitched-video').replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputPath = path.join(OUTPUT_DIR, `${outputFileName}.mp4`);

    await new Promise((resolve, reject) => {
      const cmd = `ffmpeg -y -f concat -safe 0 -i ${concatFile} -c copy ${outputPath}`;
      console.log('Stitching:', cmd);
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          console.error('Stitch error:', stderr);
          reject(error);
        } else {
          resolve();
        }
      });
    });

    const videoBuffer = fs.readFileSync(outputPath);
    const base64Video = videoBuffer.toString('base64');
    console.log(`Final video size: ${videoBuffer.length} bytes`);

    // Clean up
    [...finalScenePaths].forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
    try { fs.unlinkSync(concatFile); } catch(e) {}
    try { fs.unlinkSync(outputPath); } catch(e) {}

    res.json({ success: true, video: base64Video, filename: `${outputFileName}.mp4` });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg service running on port ${PORT}`));
