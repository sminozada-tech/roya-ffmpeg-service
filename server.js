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

function createSRT(text, durationSeconds) {
  const words = text.split(' ');
  const wordsPerLine = 4;
  const lines = [];
  for (let i = 0; i < words.length; i += wordsPerLine) {
    lines.push(words.slice(i, i + wordsPerLine).join(' '));
  }
  const timePerLine = durationSeconds / lines.length;
  let srt = '';
  lines.forEach((line, i) => {
    const start = i * timePerLine;
    const end = (i + 1) * timePerLine;
    const fmt = (s) => {
      const h = Math.floor(s / 3600).toString().padStart(2, '0');
      const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
      const sec = Math.floor(s % 60).toString().padStart(2, '0');
      const ms = Math.floor((s % 1) * 1000).toString().padStart(3, '0');
      return `${h}:${m}:${sec},${ms}`;
    };
    srt += `${i + 1}\n${fmt(start)} --> ${fmt(end)}\n${line}\n\n`;
  });
  return srt;
}

app.post('/stitch', async (req, res) => {
  try {
    const { videos, audios, captions, output_name } = req.body;

    console.log(`Received ${videos.length} videos, ${audios ? audios.length : 0} audios`);

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

      // Get video duration
      const videoDuration = await new Promise((resolve) => {
        exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${videoPath}`, (err, stdout) => {
          resolve(parseFloat(stdout) || 8);
        });
      });
      console.log(`Video ${i + 1} duration: ${videoDuration}s`);

      let currentPath = videoPath;

      // Merge audio — pad audio to match video duration, never cut video
      if (audios && audios[i]) {
        const audioPath = path.join(UPLOAD_DIR, `scene${i + 1}_audio.mp3`);
        const cleanAudio = audios[i].replace(/^data:audio\/mp3;base64,/, '').replace(/^data:audio\/mpeg;base64,/, '');
        fs.writeFileSync(audioPath, Buffer.from(cleanAudio, 'base64'));

        const mergedPath = path.join(UPLOAD_DIR, `scene${i + 1}_merged.mp4`);
        await new Promise((resolve, reject) => {
          // Use video duration as master — audio gets padded with silence if shorter
          const cmd = `ffmpeg -y -i ${currentPath} -i ${audioPath} -map 0:v -map 1:a -c:v copy -c:a aac -t ${videoDuration} ${mergedPath}`;
          console.log(`Merging audio scene ${i + 1}`);
          exec(cmd, (error, stdout, stderr) => {
            if (error) { console.error(stderr); reject(error); }
            else resolve();
          });
        });
        currentPath = mergedPath;
      }

      // Add captions if provided
      if (captions && captions[i]) {
        const srtPath = path.join(UPLOAD_DIR, `scene${i + 1}.srt`);
        const srtContent = createSRT(captions[i], videoDuration);
        fs.writeFileSync(srtPath, srtContent);

        const captionedPath = path.join(UPLOAD_DIR, `scene${i + 1}_captioned.mp4`);
        await new Promise((resolve, reject) => {
          const cmd = `ffmpeg -y -i ${currentPath} -vf "subtitles=${srtPath}:force_style='FontName=Arial,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Bold=1,Alignment=2,MarginV=50'" -c:a copy ${captionedPath}`;
          console.log(`Adding captions scene ${i + 1}`);
          exec(cmd, (error, stdout, stderr) => {
            if (error) { console.error(stderr); reject(error); }
            else resolve();
          });
        });
        currentPath = captionedPath;
      }

      finalScenePaths.push(currentPath);
    }

    // Stitch all scenes
    const concatFile = path.join(UPLOAD_DIR, 'concat.txt');
    fs.writeFileSync(concatFile, finalScenePaths.map(p => `file '${p}'`).join('\n'));

    const outputFileName = (output_name || 'stitched-video').replace(/[^a-zA-Z0-9_-]/g, '_');
    const outputPath = path.join(OUTPUT_DIR, `${outputFileName}.mp4`);

    await new Promise((resolve, reject) => {
      const cmd = `ffmpeg -y -f concat -safe 0 -i ${concatFile} -c:a aac -c:v libx264 ${outputPath}`;
      console.log('Stitching final video');
      exec(cmd, (error, stdout, stderr) => {
        if (error) { console.error(stderr); reject(error); }
        else resolve();
      });
    });

    const videoBuffer = fs.readFileSync(outputPath);
    const base64Video = videoBuffer.toString('base64');
    console.log(`Final video size: ${videoBuffer.length} bytes`);

    finalScenePaths.forEach(p => { try { fs.unlinkSync(p); } catch(e) {} });
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
