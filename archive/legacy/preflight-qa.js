const fs = require('fs');
const { execSync } = require('child_process');
const ffprobe = require('ffprobe-static');
const ffmpeg = require('ffmpeg-static');

async function runPreflightQA(mp4Path) {
  const result = { pass: true, checks: [], issues: [] };
  
  const addCheck = (name, passed, issue) => {
    result.checks.push({ name, passed });
    console.log(`${passed ? '✅' : '❌'} ${name}`);
    if (!passed) {
      result.pass = false;
      if (issue) result.issues.push(issue);
    }
  };

  try {
    // 1. File Exists & Size > 5MB
    const exists = fs.existsSync(mp4Path);
    addCheck('File Exists', exists, 'File not found');
    if (!exists) return result;
    
    const sizeMB = fs.statSync(mp4Path).size / (1024 * 1024);
    addCheck('File Size > 5MB', sizeMB > 5, `Size is only ${sizeMB.toFixed(2)}MB`);

    // 2. FFprobe Checks (Stream & Duration)
    const probeCmd = `"${ffprobe.path}" -v quiet -print_format json -show_format -show_streams "${mp4Path}"`;
    const probeData = JSON.parse(execSync(probeCmd, { encoding: 'utf-8' }));
    
    const vStream = probeData.streams.find(s => s.codec_type === 'video');
    const vPass = vStream && vStream.codec_name === 'h264' && vStream.width === 1080 && vStream.height === 1920;
    addCheck('Video: h264, 1080x1920', !!vPass, 'Missing/incorrect video stream');

    const aStream = probeData.streams.find(s => s.codec_type === 'audio');
    const aPass = aStream && aStream.codec_name === 'aac' && aStream.channels >= 1;
    addCheck('Audio: aac, channels >= 1', !!aPass, 'Missing/incorrect audio stream');

    const duration = parseFloat(probeData.format.duration);
    const dPass = duration >= 30 && duration <= 180;
    addCheck('Duration: 30-180s', dPass, `Duration is ${duration}s`);

    // 3. FFmpeg Volume Detect Check (>-50dB)
    const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const volCmd = `"${ffmpeg}" -i "${mp4Path}" -af "volumedetect" -vn -sn -dn -f null ${nullDev} 2>&1`;
    const volOutput = execSync(volCmd, { encoding: 'utf-8' });
    const meanVolMatch = volOutput.match(/mean_volume:\s+([-\d.]+) dB/);
    const meanVol = meanVolMatch ? parseFloat(meanVolMatch[1]) : -999;
    addCheck('Audio Not Silent (>-50dB)', meanVol > -50, `Mean volume is ${meanVol}dB`);

  } catch (error) {
    addCheck('Execution Error', false, error.message);
  }
  
  return result;
}

module.exports = { runPreflightQA };
