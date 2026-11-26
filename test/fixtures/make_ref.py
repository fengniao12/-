import wave, math, struct, os

rate = 24000
secs = 1.2
n = int(rate * secs)
with wave.open(r'test\fixtures\ref.wav', 'wb') as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(rate)
    frames = b''.join(
        struct.pack('<h', int(11000 * math.sin(2 * math.pi * 330 * i / rate) * (1 - i / n)))
        for i in range(n)
    )
    w.writeframes(frames)
print(os.path.getsize(r'test\fixtures\ref.wav'))
