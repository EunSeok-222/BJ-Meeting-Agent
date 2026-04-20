const fs = require("fs");
const path = require("path");
const { ffmpeg } = require("../config/clients");

async function mergePcmFiles(files, recordingsDir, tempPcm) {
  const mergedWriteStream = fs.createWriteStream(tempPcm);

  for (const file of files) {
    const filePath = path.join(recordingsDir, file);
    try {
      const data = fs.readFileSync(filePath);
      mergedWriteStream.write(data);
      // 처리된 조각 파일은 즉시 삭제
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`파일 처리 중 에러 (${file}):`, err.message);
    }
  }
  mergedWriteStream.end();

  return new Promise((resolve, reject) => {
    mergedWriteStream.on("finish", resolve);
    mergedWriteStream.on("error", reject);
  });
}

async function convertToMp3(inputPcm, outputMedia) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inputPcm)
      .inputOptions(["-f s16le", "-ar 48000", "-ac 2"])
      .outputOptions(["-f mp3", "-ar 16000", "-ac 1", "-b:a 64k"])
      .output(outputMedia)
      .on("start", (commandLine) => {
        console.log("FFmpeg 변환 시작: " + commandLine);
      })
      .on("error", (err) => {
        console.error("FFmpeg 에러:", err.message);
        reject(err);
      })
      .on("end", () => {
        console.log("오디오 변환(압축) 완료!");
        resolve();
      })
      .run();
  });
}

module.exports = {
  mergePcmFiles,
  convertToMp3
};
