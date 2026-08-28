const { ffmpeg } = require("../config/clients");

/**
 * 디스코드에서 수집한 원본 PCM(s16le, 48kHz, 스테레오)을
 * Whisper 전사에 적합한 WAV(16kHz, 모노)로 변환합니다.
 */
async function convertPcmToWav(inputPcm, outputWav) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(inputPcm)
      .inputOptions(["-f s16le", "-ar 48000", "-ac 2"])
      .outputOptions(["-f wav", "-ar 16000", "-ac 1"])
      .output(outputWav)
      .on("error", (err) => {
        console.error("FFmpeg WAV 변환 에러:", err.message);
        reject(err);
      })
      .on("end", () => resolve())
      .run();
  });
}

module.exports = {
  convertPcmToWav,
};
