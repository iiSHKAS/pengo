#!/usr/bin/env python3
"""Screenshot app that plays a notification sound when a screenshot is taken.

Requirements:  pip install pillow      (and paplay or ffplay for sound)
Run:           python3 screenshot_app.py
"""
import math
import os
import random
import shutil
import struct
import subprocess
import tempfile
import tkinter as tk
import wave
from datetime import datetime
from tkinter import filedialog, messagebox, ttk

from PIL import ImageGrab

RATE = 44100


def tone(freq, dur, vol=0.5, decay=6.0):
    n = int(RATE * dur)
    return [vol * math.sin(2 * math.pi * freq * i / RATE) * math.exp(-decay * i / n) for i in range(n)]


def noise(dur, vol=0.5, decay=25.0):
    n = int(RATE * dur)
    return [vol * random.uniform(-1, 1) * math.exp(-decay * i / n) for i in range(n)]


def mix_seq(*parts):
    out = []
    for p in parts:
        out += p
    return out


def lowpass(x, a):
    y, out = 0.0, []
    for s in x:
        y += a * (s - y)
        out.append(y)
    return out


def highpass(x, a):
    lp = lowpass(x, a)
    return [s - l for s, l in zip(x, lp)]


def thump(f0, f1, dur, vol=0.7, decay=9.0):
    """Sine that sweeps from f0 down to f1 - the 'body' of a mechanical click."""
    n, ph, out = int(RATE * dur), 0.0, []
    for i in range(n):
        f = f1 + (f0 - f1) * math.exp(-8.0 * i / n)
        ph += 2 * math.pi * f / RATE
        out.append(vol * math.sin(ph) * math.exp(-decay * i / n))
    return out


def snap(dur, vol=0.6, decay=18.0, lp=0.5, hp=None):
    """Filtered noise burst - the 'metal snap' of a shutter."""
    x = noise(dur, vol, decay)
    x = lowpass(x, lp)
    return highpass(x, hp) if hp else x


def silence(dur):
    return [0.0] * int(RATE * dur)


def layer(*parts):
    """Overlay (start_time, samples) pairs into one buffer."""
    end = max(int(t * RATE) + len(s) for t, s in parts)
    out = [0.0] * end
    for t, s in parts:
        o = int(t * RATE)
        for i, v in enumerate(s):
            out[o + i] += v
    return out


def partials(freqs, dur, vol=0.4, decay=7.0):
    return layer(*[(0, tone(f, dur, vol / (k + 1), decay + k * 2)) for k, f in enumerate(freqs)])


def sweep(f0, f1, dur, vol=0.3):
    n, ph, out = int(RATE * dur), 0.0, []
    for i in range(n):
        ph += 2 * math.pi * (f0 + (f1 - f0) * i / n) / RATE
        env = math.sin(math.pi * i / n)
        out.append(vol * env * (math.sin(ph) + 0.4 * random.uniform(-1, 1)))
    return out


# Suggested screenshot sounds, generated in code (no extra files needed)
SOUNDS = {
    # Two-stage mirror + shutter: "ka-chk"
    "DSLR shutter (suggested)": lambda: layer(
        (0.00, thump(220, 90, 0.07, 0.8)), (0.00, snap(0.05, 0.5, 14, 0.6, 0.05)),
        (0.075, thump(160, 70, 0.08, 0.6)), (0.075, snap(0.07, 0.4, 12, 0.45, 0.05))),
    # Short, crisp phone-style click
    "Phone camera": lambda: layer(
        (0.00, snap(0.03, 0.7, 30, 0.9, 0.2)), (0.00, tone(2600, 0.03, 0.3, 20)),
        (0.045, snap(0.025, 0.4, 30, 0.8, 0.2))),
    # Heavier film-camera clack plus a faint film-wind rustle
    "Film camera": lambda: layer(
        (0.00, thump(260, 70, 0.1, 0.9, 7)), (0.00, snap(0.06, 0.6, 12, 0.5, 0.03)),
        (0.11, thump(150, 55, 0.12, 0.7, 6)), (0.11, snap(0.08, 0.4, 10, 0.4, 0.03)),
        (0.30, snap(0.30, 0.12, 3, 0.25, 0.05))),
    # Click followed by the motor whirr of an instant camera
    "Polaroid": lambda: layer(
        (0.00, thump(240, 80, 0.08, 0.8)), (0.00, snap(0.05, 0.5, 14, 0.6, 0.05)),
        (0.15, sweep(300, 900, 0.55, 0.25))),
    # Rising sparkle - feels like a "capture saved" moment
    "Sparkle": lambda: layer(*[(i * 0.06, partials([f, f * 2.01], 0.35, 0.35, 8))
                                for i, f in enumerate([1047, 1319, 1568, 2093])]),
    # Soft glassy tap
    "Glass tap": lambda: partials([2093, 3136, 4186], 0.45, 0.5, 9),
    "Soft ding": lambda: tone(1320, 0.5, 0.5, 7),
    "Chime": lambda: mix_seq(tone(880, 0.15, 0.5, 3), tone(1175, 0.15, 0.5, 3), tone(1568, 0.5, 0.5, 6)),
    "Success": lambda: mix_seq(tone(660, 0.12, 0.5, 2), tone(880, 0.3, 0.5, 5)),
}


def make_wav(name):
    path = os.path.join(tempfile.gettempdir(), "shot2_" +"".join(c for c in name if c.isalnum()) + ".wav")
    if not os.path.exists(path):
        samples = SOUNDS[name]()
        with wave.open(path, "w") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32767)) for s in samples))
    return path


def play(path):
    for cmd in (["paplay", path], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path]):
        if shutil.which(cmd[0]):
            subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Screenshot App")
        self.resizable(False, False)
        self.custom_sound = ""
        pad = {"padx": 10, "pady": 6}
        f = ttk.Frame(self)
        f.grid(padx=10, pady=10)

        ttk.Label(f, text="Notification sound:").grid(row=0, column=0, sticky="w", **pad)
        self.sound_var = tk.StringVar(value=next(iter(SOUNDS)))
        cb = ttk.Combobox(f, textvariable=self.sound_var, state="readonly", width=28,
                          values=["No sound", *SOUNDS, "Custom file..."])
        cb.grid(row=0, column=1, **pad)
        cb.bind("<<ComboboxSelected>>", self.on_sound_change)
        ttk.Button(f, text="▶ Test", command=self.preview).grid(row=0, column=2, **pad)

        ttk.Label(f, text="Save to:").grid(row=1, column=0, sticky="w", **pad)
        self.dir_var = tk.StringVar(value=os.path.expanduser("~/Pictures"))
        ttk.Entry(f, textvariable=self.dir_var, width=31).grid(row=1, column=1, **pad)
        ttk.Button(f, text="Browse", command=self.browse).grid(row=1, column=2, **pad)

        ttk.Label(f, text="Delay (seconds):").grid(row=2, column=0, sticky="w", **pad)
        self.delay_var = tk.StringVar(value="0")
        ttk.Spinbox(f, from_=0, to=30, textvariable=self.delay_var, width=6).grid(row=2, column=1, sticky="w", **pad)

        ttk.Button(f, text="📷 Take Screenshot", command=self.shoot).grid(
            row=3, column=0, columnspan=3, ipadx=20, ipady=6, pady=8)
        self.status = ttk.Label(f, text="Ready")
        self.status.grid(row=4, column=0, columnspan=3)

    def on_sound_change(self, _=None):
        if self.sound_var.get() == "Custom file...":
            p = filedialog.askopenfilename(filetypes=[("Audio", "*.wav *.mp3 *.ogg *.oga *.flac")])
            if p:
                self.custom_sound = p
            else:
                self.sound_var.set(next(iter(SOUNDS)))
        else:
            self.preview()

    def sound_path(self):
        name = self.sound_var.get()
        if name == "No sound":
            return None
        if name == "Custom file...":
            return self.custom_sound or None
        return make_wav(name)

    def preview(self):
        p = self.sound_path()
        if p:
            play(p)

    def browse(self):
        d = filedialog.askdirectory(initialdir=self.dir_var.get())
        if d:
            self.dir_var.set(d)

    def shoot(self):
        try:
            delay = int(self.delay_var.get())
        except ValueError:
            delay = 0
        self.withdraw()
        self.after(max(delay, 0) * 1000 + 300, self.capture)

    def capture(self):
        try:
            img = ImageGrab.grab()
        except Exception as e:
            self.deiconify()
            messagebox.showerror("Error", f"Could not capture the screen:\n{e}\n\n"
                                          "On Wayland, try an X11 session.")
            return
        os.makedirs(self.dir_var.get(), exist_ok=True)
        path = os.path.join(self.dir_var.get(), datetime.now().strftime("screenshot_%Y%m%d_%H%M%S.png"))
        img.save(path)
        p = self.sound_path()
        if p:
            play(p)
        self.deiconify()
        self.status.config(text=f"Saved: {path}")


if __name__ == "__main__":
    App().mainloop()
