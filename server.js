const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '100mb' }));

const UPLOAD_DIR = '/tmp/uploads';
const OUTPUT_DIR = '/tmp/output';

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.post('/stitch', async (req, res) => {
  try {
    const { videos, audios, subtitles, output_name } = req.body;
    console.log(`Received ${videos.length} videos`);
    console.log(`Subtitles received: ${subtitles ? subtitles.length : 0}`);
    if (subtitles) {
      subtitles.forEach((sub, i) => console.log(`Scene ${i+1} subtitle: "${sub}"`));
    }

    // Clean up
    const oldFiles = fs.readdirSync(UPLOAD_DIR);
    oldFiles.forEach(file => fs.unlinkSync(path.join(UPLOAD_DIR, file)));

    const mergedPaths = [];

    for (let i = 0; i < videos.length; i++) {
      const videoPath = path.join(UPLOAD_DIR, `scene${i+1}.mp4`);
      const audioPath = path.join(UPLOAD_DIR, `scene${i+1}.mp3`);
      const srtPath = path.join(UPLOAD_DIR, `scene${i+1}.srt`);
      const mergedPath = path.join(UPLOAD_DIR, `merged${i+1}.mp4`);

      // Write Video
      fs.writeFileSync(videoPath, Buffer.from(videos[i].replace(/^data:video\/mp4;base64,/, ''), 'base64'));

      // Create SRT file for subtitles (more reliable than drawtext)
      const subText = (subtitles && subtitles[i]) ? subtitles[i] : "";
      const srtContent = `1
00:00:00,000 --> 00:00:08,000
${subText}

`;
      fs.writeFileSync(srtPath, srtContent);
      console.log(`Created SRT for scene ${i+1}: ${subText}`);

      let cmd = `ffmpeg -y -i ${videoPath}`;
      
      let hasAudio = false;
      if (audios && audios[i]) {
        fs.writeFileSync(audioPath, Buffer.from(audios[i], 'base64'));
        cmd += ` -i ${audioPath}`;
        hasAudio = true;
      }

      // Use subtitle filter to burn in SRT
      // This is more reliable than drawtext
      if (subText.trim()) {
        const filter = `subtitles='${srtPath.replace(/'/g, "'\\\\''")}'`;
        
        if (hasAudio) {
          cmd += ` -vf "${filter}" -c:a aac -map 0:v -map 1:a -shortest ${mergedPath}`;
        } else {
          cmd += ` -vf "${filter}" -an ${mergedPath}`;
        }
      } else {
        // No subtitles
        if (hasAudio) {
          cmd += ` -c:v copy -c:a aac -map 0:v -map 1:a -shortest ${mergedPath}`;
        } else {
          cmd += ` -c:v copy -an ${mergedPath}`;
        }
      }

      console.log(`Running: ${cmd}`);
      await new Promise((resolve, reject) => {
        exec(cmd, (error, stdout, stderr) => {
          if (error) {
            console.error(`FFmpeg error scene ${i+1}:`, stderr);
            // Fallback: just copy video without subs
            fs.copyFileSync(videoPath, mergedPath);
          }
          resolve();
        });
      });
      
      mergedPaths.push(mergedPath);
    }

    // Stitch
    const concatFile = path.join(UPLOAD_DIR, 'concat.txt');
    fs.writeFileSync(concatFile, mergedPaths.map(p => `file '${p}'`).join('\n'));

    const outputFileName = (output_name || 'stitched-video').replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputPath = path.join(OUTPUT_DIR, `${outputFileName}.mp4`);
    
    const stitchCmd = `ffmpeg -y -f concat -safe 0 -i ${concatFile} -c copy ${outputPath}`;
    await new Promise((resolve, reject) => {
      exec(stitchCmd, (err) => err ? reject(err) : resolve());
    });

    const videoBuffer = fs.readFileSync(outputPath);
    res.json({ success: true, video: videoBuffer.toString('base64'), filename: `${outputFileName}.mp4` });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FFmpeg service running on port ${PORT}`));
