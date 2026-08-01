#!/opt/whisper-venv/bin/python
# Транскрибация аудио через faster-whisper.
# Использование: transcribe.py <audio_or_video_file> [speaker_label]
# Выводит JSON: {"segments":[{"start":..,"end":..,"text":..,"speaker":..}], "duration":..}
import sys, json, os

def main():
    path = sys.argv[1]
    speaker = sys.argv[2] if len(sys.argv) > 2 else None
    model_size = os.environ.get("WHISPER_MODEL", "small")

    from faster_whisper import WhisperModel
    # int8 на CPU, оба ядра — компромисс скорости и памяти
    model = WhisperModel(model_size, device="cpu", compute_type="int8", cpu_threads=2)

    segments, info = model.transcribe(
        path,
        language="ru",
        beam_size=1,                   # жадный поиск — вдвое быстрее на слабом CPU
        vad_filter=True,               # отсекаем тишину — быстрее и чище
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,
    )

    out = []
    for s in segments:
        text = s.text.strip()
        if not text:
            continue
        out.append({
            "start": round(s.start, 2),
            "end": round(s.end, 2),
            "text": text,
            "speaker": speaker,
        })

    print(json.dumps({
        "segments": out,
        "duration": round(info.duration, 2),
        "language": info.language,
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
