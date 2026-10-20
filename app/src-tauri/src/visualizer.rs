//! The sound this computer is playing, as a few band levels for the tile floor.
//!
//! No player says what its music sounds like: Spotify's audio analysis is
//! closed to apps created since late 2024, which is every reader's own Client
//! ID, and ytmdesktop2's API carries no audio. So the floor listens to the
//! default output device itself, through WASAPI loopback — whatever the
//! speakers play, the player included. Music playing on another device (a
//! phone driven over Spotify Connect) makes no sound here, and the floor rests.
//!
//! Capture runs on a thread of its own, because COM wants an apartment per
//! thread, and only while the interface has the floor on screen: it starts on
//! request and stops when asked, or with the app. (A page that reloads without
//! asking leaves it running until the next start or stop: sending to a
//! reloaded page does not fail.)

use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use windows::core::GUID;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

/// Levels per frame, lowest frequency first.
pub const BANDS: usize = 16;
/// 2048 samples at 48 kHz is 43 ms: fine enough to split the bass, short
/// enough that a drum hit shows on the beat.
const FFT_SIZE: usize = 2048;
/// About one screen frame.
const TICK: Duration = Duration::from_millis(16);
/// How often to check whether Windows moved the sound to another device.
const DEVICE_CHECK: Duration = Duration::from_secs(2);
/// After a failure (no output device, a device unplugged mid-song), wait this
/// long before opening the default one again.
const RETRY: Duration = Duration::from_secs(1);
/// What a falling level keeps of itself each tick; a rise shows at once.
const DECAY: f32 = 0.86;
/// Ticks in a row with nothing heard before the analysis window is emptied:
/// longer than the window itself (43 ms), so a late packet is not a pause.
const QUIET_TICKS: u32 = 4;
/// Band edges, spaced evenly in pitch.
const LOWEST_HZ: f32 = 45.0;
const HIGHEST_HZ: f32 = 14_000.0;
/// The level scale in dBFS, after the tilt below: quieter than the floor is
/// nothing, louder than the ceiling is a full tile.
const FLOOR_DB: f32 = -52.0;
const CEILING_DB: f32 = -12.0;
/// Loopback can be very quiet at comfortable headphone volumes. Lift only the
/// analysis signal, with a cap so near-silence is never normalized to full scale.
const TARGET_PEAK: f32 = 0.25;
const MAX_ANALYSIS_GAIN: f32 = 32.0;
/// Music carries less energy the higher it goes. Lifting each octave by this
/// much keeps the treble tiles moving instead of the bass drowning them.
const TILT_DB_PER_OCTAVE: f32 = 3.5;

/// `WAVE_FORMAT_IEEE_FLOAT` and `WAVE_FORMAT_EXTENSIBLE`; the extensible
/// header then names the sample type by GUID.
const FORMAT_FLOAT: u16 = 3;
const FORMAT_EXTENSIBLE: u16 = 0xFFFE;
const SUBTYPE_FLOAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);
const SUBTYPE_PCM: GUID = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);
/// `AUDCLNT_BUFFERFLAGS_SILENT`: the packet is silence whatever it holds.
const BUFFER_SILENT: u32 = 2;

/// The running capture, if any. One floor is on screen at a time.
#[derive(Default)]
pub struct Visualizer {
    running: Mutex<Option<Capture>>,
}

struct Capture {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

impl Visualizer {
    /// Start sending levels to `channel`, replacing whatever was sending before.
    pub fn start(&self, channel: Channel<Vec<u8>>) {
        let mut running = self.running.lock().unwrap();
        if let Some(previous) = running.take() {
            previous.finish();
        }
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::Builder::new()
            .name("visualizer".into())
            .spawn(move || listen(&flag, |levels| channel.send(levels.to_vec()).is_ok()))
            .expect("the visualizer thread must start");
        *running = Some(Capture { stop, thread });
    }

    pub fn stop(&self) {
        if let Some(capture) = self.running.lock().unwrap().take() {
            capture.finish();
        }
    }
}

impl Capture {
    /// Ask the thread to end, without waiting for it. It notices within a
    /// tick, but opening a device can take far longer (a Bluetooth headset
    /// waking), and the commands that call this run on the UI thread. A new
    /// capture may start meanwhile; the old one sends to a channel the page
    /// has already let go.
    fn finish(self) {
        self.stop.store(true, Ordering::SeqCst);
        drop(self.thread);
    }
}

/// How the device hands over its samples.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Sample {
    Float32,
    Int16,
    Int32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Format {
    channels: usize,
    rate: f32,
    sample: Sample,
}

/// Read the device's mix format. Shared-mode loopback has to take it as is.
///
/// # Safety
/// `format` must point at a format WASAPI returned.
unsafe fn read_format(format: *const WAVEFORMATEX) -> Option<Format> {
    let header = unsafe { std::ptr::read_unaligned(format) };
    let tag = header.wFormatTag;
    let bits = header.wBitsPerSample;
    let float = match tag {
        FORMAT_FLOAT => true,
        FORMAT_EXTENSIBLE => {
            let extensible =
                unsafe { std::ptr::read_unaligned(format as *const WAVEFORMATEXTENSIBLE) };
            let subtype = extensible.SubFormat;
            if subtype == SUBTYPE_FLOAT {
                true
            } else if subtype == SUBTYPE_PCM {
                false
            } else {
                return None;
            }
        }
        // WAVE_FORMAT_PCM
        1 => false,
        _ => return None,
    };
    let sample = match (float, bits) {
        (true, 32) => Sample::Float32,
        (false, 16) => Sample::Int16,
        (false, 32) => Sample::Int32,
        _ => return None,
    };
    let channels = usize::from(header.nChannels);
    let rate = header.nSamplesPerSec as f32;
    (channels > 0 && rate > 0.0).then_some(Format {
        channels,
        rate,
        sample,
    })
}

/// One open loopback stream on the default output device.
struct Stream {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    device_id: String,
    format: Format,
}

impl Drop for Stream {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

fn default_device_id(enumerator: &IMMDeviceEnumerator) -> windows::core::Result<String> {
    unsafe {
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let raw = device.GetId()?;
        let id = raw.to_string().unwrap_or_default();
        CoTaskMemFree(Some(raw.0 as *const _));
        Ok(id)
    }
}

fn open(enumerator: &IMMDeviceEnumerator) -> windows::core::Result<Option<Stream>> {
    unsafe {
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let raw = device.GetId()?;
        let device_id = raw.to_string().unwrap_or_default();
        CoTaskMemFree(Some(raw.0 as *const _));

        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
        let mix = client.GetMixFormat()?;
        let format = read_format(mix);
        let initialized = match format {
            // A 200 ms buffer, emptied every tick, never overflows.
            Some(_) => client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                2_000_000,
                0,
                mix,
                None,
            ),
            None => Ok(()),
        };
        CoTaskMemFree(Some(mix as *const _));
        initialized?;
        let Some(format) = format else {
            return Ok(None);
        };
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        Ok(Some(Stream {
            client,
            capture,
            device_id,
            format,
        }))
    }
}

/// Capture until `stop` is set or `send` reports nobody is listening.
fn listen(stop: &AtomicBool, mut send: impl FnMut(&[u8; BANDS]) -> bool) {
    unsafe {
        // Already initialized is fine; anything else leaves nothing to listen with.
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            return;
        }
    }
    let enumerator: Option<IMMDeviceEnumerator> =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok() };
    if let Some(enumerator) = enumerator {
        let mut analyser = Analyser::new();
        while !stop.load(Ordering::SeqCst) {
            let stream = match open(&enumerator) {
                Ok(Some(stream)) => stream,
                // No output device, or one in a format this does not read: the
                // floor rests, and the next attempt may find another.
                _ => {
                    if !rest(stop, &mut analyser, &mut send, RETRY) {
                        break;
                    }
                    continue;
                }
            };
            if !run(stop, &enumerator, &stream, &mut analyser, &mut send) {
                break;
            }
        }
        drop(enumerator);
    }
    unsafe { CoUninitialize() };
}

/// Let the levels fall to nothing over `wait`. False when nobody listens.
fn rest(
    stop: &AtomicBool,
    analyser: &mut Analyser,
    send: &mut impl FnMut(&[u8; BANDS]) -> bool,
    wait: Duration,
) -> bool {
    let until = Instant::now() + wait;
    while Instant::now() < until && !stop.load(Ordering::SeqCst) {
        if let Some(levels) = analyser.fall() {
            if !send(&levels) {
                return false;
            }
        }
        std::thread::sleep(TICK);
    }
    true
}

/// Read one stream until it fails or the default device changes. False when
/// capture should end altogether.
fn run(
    stop: &AtomicBool,
    enumerator: &IMMDeviceEnumerator,
    stream: &Stream,
    analyser: &mut Analyser,
    send: &mut impl FnMut(&[u8; BANDS]) -> bool,
) -> bool {
    let mut checked = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        let heard = match drain(stream, analyser) {
            Ok(heard) => heard,
            // The device went away under the stream: open the new default.
            Err(_) => return rest(stop, analyser, send, RETRY),
        };
        // Windows plays nothing into loopback while nothing plays, so silence
        // arrives as no packets at all rather than as quiet ones.
        let levels = if heard {
            Some(analyser.levels(stream.format.rate))
        } else {
            analyser.fall()
        };
        if let Some(levels) = levels {
            if !send(&levels) {
                return false;
            }
        }
        if checked.elapsed() >= DEVICE_CHECK {
            checked = Instant::now();
            if default_device_id(enumerator).ok().as_deref() != Some(stream.device_id.as_str()) {
                return true;
            }
        }
        std::thread::sleep(TICK);
    }
    false
}

/// Move every waiting packet into the analyser. True when any arrived.
fn drain(stream: &Stream, analyser: &mut Analyser) -> windows::core::Result<bool> {
    let mut heard = false;
    unsafe {
        while stream.capture.GetNextPacketSize()? > 0 {
            let mut data = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            stream
                .capture
                .GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
            let count = frames as usize * stream.format.channels;
            if flags & BUFFER_SILENT != 0 || data.is_null() {
                analyser.push_silence(frames as usize);
            } else {
                match stream.format.sample {
                    Sample::Float32 => {
                        let samples = std::slice::from_raw_parts(data as *const f32, count);
                        analyser.push(samples, stream.format.channels, |value| value);
                    }
                    Sample::Int16 => {
                        let samples = std::slice::from_raw_parts(data as *const i16, count);
                        analyser.push(samples, stream.format.channels, |value| {
                            f32::from(value) / 32_768.0
                        });
                    }
                    Sample::Int32 => {
                        let samples = std::slice::from_raw_parts(data as *const i32, count);
                        analyser.push(samples, stream.format.channels, |value| {
                            value as f32 / 2_147_483_648.0
                        });
                    }
                }
            }
            stream.capture.ReleaseBuffer(frames)?;
            heard = true;
        }
    }
    Ok(heard)
}

/// The last `FFT_SIZE` samples, mixed to mono, and the levels shown last.
struct Analyser {
    ring: Vec<f32>,
    /// Where the next sample goes; the oldest sample is here too.
    head: usize,
    window: Vec<f32>,
    shown: [f32; BANDS],
    /// Ticks since anything was heard.
    quiet: u32,
}

impl Analyser {
    fn new() -> Self {
        Self {
            ring: vec![0.0; FFT_SIZE],
            head: 0,
            window: (0..FFT_SIZE)
                .map(|index| 0.5 - 0.5 * (2.0 * PI * index as f32 / FFT_SIZE as f32).cos())
                .collect(),
            shown: [0.0; BANDS],
            quiet: 0,
        }
    }

    fn push<T: Copy>(&mut self, samples: &[T], channels: usize, to_f32: impl Fn(T) -> f32) {
        // Surround devices often pad stereo music with silent channels. Count
        // occupied channels per packet, not per sample (a zero crossing is sound).
        let active_channels = (0..channels)
            .filter(|&channel| {
                samples
                    .iter()
                    .skip(channel)
                    .step_by(channels)
                    .any(|value| to_f32(*value) != 0.0)
            })
            .count()
            .max(1) as f32;
        for frame in samples.chunks_exact(channels) {
            let sum: f32 = frame.iter().map(|value| to_f32(*value)).sum();
            self.ring[self.head] = sum / active_channels;
            self.head = (self.head + 1) % FFT_SIZE;
        }
    }

    fn push_silence(&mut self, frames: usize) {
        for _ in 0..frames.min(FFT_SIZE) {
            self.ring[self.head] = 0.0;
            self.head = (self.head + 1) % FFT_SIZE;
        }
    }

    /// Analyse what is in the ring now.
    fn levels(&mut self, rate: f32) -> [u8; BANDS] {
        self.quiet = 0;
        let peak = self
            .ring
            .iter()
            .map(|sample| sample.abs())
            .fold(0.0f32, f32::max);
        let gain = (TARGET_PEAK / peak.max(1e-9)).clamp(1.0, MAX_ANALYSIS_GAIN);
        let mut re: Vec<f32> = (0..FFT_SIZE)
            .map(|index| self.ring[(self.head + index) % FFT_SIZE] * self.window[index] * gain)
            .collect();
        let mut im = vec![0.0; FFT_SIZE];
        fft(&mut re, &mut im);
        let target = band_levels(&re, &im, rate);
        for (shown, target) in self.shown.iter_mut().zip(target) {
            *shown = target.max(*shown * DECAY);
        }
        quantize(&self.shown)
    }

    /// One tick with nothing heard. `None` once everything has come to rest,
    /// so a silent computer is not sent sixty empty frames a second.
    fn fall(&mut self) -> Option<[u8; BANDS]> {
        self.quiet = self.quiet.saturating_add(1);
        // A pause, not a late packet: let the window go, or it would replay
        // its last sound when the music resumes.
        if self.quiet == QUIET_TICKS {
            self.ring.fill(0.0);
        }
        if self.shown.iter().all(|level| *level == 0.0) {
            return None;
        }
        for shown in &mut self.shown {
            *shown *= DECAY;
            if *shown < 0.01 {
                *shown = 0.0;
            }
        }
        Some(quantize(&self.shown))
    }
}

fn quantize(levels: &[f32; BANDS]) -> [u8; BANDS] {
    levels.map(|level| (level.clamp(0.0, 1.0) * 255.0).round() as u8)
}

/// Each band's level, 0 to 1, from one transform.
fn band_levels(re: &[f32], im: &[f32], rate: f32) -> [f32; BANDS] {
    let bin_hz = rate / FFT_SIZE as f32;
    let top_bin = FFT_SIZE / 2 - 1;
    // A Hann window halves a sine's peak; this scales one back to its amplitude.
    let scale = 4.0 / FFT_SIZE as f32;
    let ratio = (HIGHEST_HZ / LOWEST_HZ).powf(1.0 / BANDS as f32);
    let mut levels = [0.0; BANDS];
    for (band, level) in levels.iter_mut().enumerate() {
        let low = LOWEST_HZ * ratio.powi(band as i32);
        let high = low * ratio;
        let first = ((low / bin_hz).floor() as usize).clamp(1, top_bin);
        let last = ((high / bin_hz).ceil() as usize).clamp(first, top_bin);
        let peak = (first..=last)
            .map(|bin| (re[bin] * re[bin] + im[bin] * im[bin]).sqrt() * scale)
            .fold(0.0f32, f32::max);
        let centre = (low * high).sqrt();
        let db = 20.0 * (peak + 1e-9).log10() + TILT_DB_PER_OCTAVE * (centre / 1000.0).log2();
        *level = ((db - FLOOR_DB) / (CEILING_DB - FLOOR_DB)).clamp(0.0, 1.0);
    }
    levels
}

/// In-place radix-2 FFT. `re.len()` must be a power of two.
fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut length = 2;
    while length <= n {
        let angle = -2.0 * PI / length as f32;
        let (step_im, step_re) = angle.sin_cos();
        for start in (0..n).step_by(length) {
            let (mut w_re, mut w_im) = (1.0f32, 0.0f32);
            for offset in 0..length / 2 {
                let a = start + offset;
                let b = a + length / 2;
                let t_re = re[b] * w_re - im[b] * w_im;
                let t_im = re[b] * w_im + im[b] * w_re;
                re[b] = re[a] - t_re;
                im[b] = im[a] - t_im;
                re[a] += t_re;
                im[a] += t_im;
                let next = w_re * step_re - w_im * step_im;
                w_im = w_re * step_im + w_im * step_re;
                w_re = next;
            }
        }
        length <<= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn tone(hz: f32, amplitude: f32) -> Vec<f32> {
        (0..FFT_SIZE * 2)
            .map(|index| amplitude * (2.0 * PI * hz * index as f32 / RATE).sin())
            .collect()
    }

    fn band_of(hz: f32) -> usize {
        let ratio = (HIGHEST_HZ / LOWEST_HZ).powf(1.0 / BANDS as f32);
        ((hz / LOWEST_HZ).ln() / ratio.ln()).floor() as usize
    }

    #[test]
    fn the_transform_finds_a_tone_in_its_own_bin() {
        let mut re: Vec<f32> = (0..64).map(|i| (2.0 * PI * 5.0 * i as f32 / 64.0).cos()).collect();
        let mut im = vec![0.0; 64];
        fft(&mut re, &mut im);
        let magnitude = |bin: usize| (re[bin] * re[bin] + im[bin] * im[bin]).sqrt();
        assert!((magnitude(5) - 32.0).abs() < 1e-3);
        assert!(magnitude(4) < 1e-3 && magnitude(6) < 1e-3);
    }

    #[test]
    fn a_loud_tone_fills_its_band_and_leaves_far_ones_still() {
        for hz in [80.0, 440.0, 1_000.0, 6_000.0] {
            let mut analyser = Analyser::new();
            analyser.push(&tone(hz, 0.5), 1, |value| value);
            let levels = analyser.levels(RATE);
            let band = band_of(hz);
            assert!(levels[band] > 200, "{hz} Hz: band {band} = {}", levels[band]);
            for (other, level) in levels.iter().enumerate() {
                if other.abs_diff(band) > 2 {
                    assert!(*level < 60, "{hz} Hz leaks into band {other}: {level}");
                }
            }
        }
    }

    #[test]
    fn stereo_is_mixed_and_integer_samples_are_scaled() {
        let mono = tone(440.0, 0.5);
        let stereo: Vec<i16> = mono
            .iter()
            .flat_map(|value| {
                let sample = (value * 32_767.0) as i16;
                [sample, sample]
            })
            .collect();
        let mut from_float = Analyser::new();
        from_float.push(&mono, 1, |value| value);
        let mut from_int = Analyser::new();
        from_int.push(&stereo, 2, |value| f32::from(value) / 32_768.0);
        let (a, b) = (from_float.levels(RATE), from_int.levels(RATE));
        assert!(a.iter().zip(b).all(|(a, b)| a.abs_diff(b) <= 2));
    }

    #[test]
    fn quiet_music_survives_silent_surround_channels() {
        // The INZONE H5 supplies eight channels, but stereo music occupies two.
        for hz in [80.0, 440.0, 1_000.0, 6_000.0] {
            let mono = tone(hz, 0.003);
            let surround: Vec<f32> = mono
                .iter()
                .flat_map(|&sample| [sample, sample, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0])
                .collect();
            let mut original = Analyser::new();
            original.push(&mono, 1, |value| value);
            let mut padded = Analyser::new();
            padded.push(&surround, 8, |value| value);
            let (a, b) = (original.levels(RATE), padded.levels(RATE));
            assert!(b[band_of(hz)] > 40, "{hz} Hz stays invisible: {b:?}");
            assert_eq!(a, b, "silent channels must not attenuate {hz} Hz");
        }
    }

    #[test]
    fn surround_only_audio_is_not_discarded() {
        let mono = tone(440.0, 0.003);
        let surround: Vec<f32> = mono
            .iter()
            .flat_map(|&sample| [0.0, 0.0, 0.0, 0.0, sample, sample, 0.0, 0.0])
            .collect();
        let mut analyser = Analyser::new();
        analyser.push(&surround, 8, |value| value);
        assert!(analyser.levels(RATE)[band_of(440.0)] > 40);
    }

    #[test]
    fn quiet_input_gain_does_not_turn_silence_or_tiny_noise_into_music() {
        let mut analyser = Analyser::new();
        for hz in [80.0, 440.0, 1_000.0, 6_000.0] {
            analyser.push(&tone(hz, 1e-7), 1, |value| value);
            assert_eq!(analyser.levels(RATE), [0; BANDS]);
        }
        analyser.push(&tone(440.0, 0.003), 1, |value| value);
        assert!(analyser.levels(RATE)[band_of(440.0)] > 40);
        analyser.push_silence(FFT_SIZE);
        for _ in 0..120 {
            analyser.levels(RATE);
        }
        assert_eq!(analyser.levels(RATE), [0; BANDS]);
    }

    #[test]
    fn silence_shows_nothing_and_a_sound_falls_away_then_stops_sending() {
        let mut analyser = Analyser::new();
        analyser.push_silence(FFT_SIZE);
        assert_eq!(analyser.levels(RATE), [0; BANDS]);

        analyser.push(&tone(440.0, 0.5), 1, |value| value);
        let loud = analyser.levels(RATE)[band_of(440.0)];
        let first = analyser.fall().unwrap()[band_of(440.0)];
        assert!(first < loud);
        let mut frames = 1;
        while analyser.fall().is_some() {
            frames += 1;
            assert!(frames < 120, "a level must come to rest");
        }
        assert!(analyser.fall().is_none());
    }

    #[test]
    fn a_late_packet_is_not_a_pause() {
        let mut analyser = Analyser::new();
        analyser.push(&tone(80.0, 0.5), 1, |value| value);
        let loud = analyser.levels(RATE)[band_of(80.0)];
        // One tick goes by with nothing; the next packet still sees the bass.
        analyser.fall();
        analyser.push_silence(480);
        assert!(analyser.levels(RATE)[band_of(80.0)] + 8 >= loud);
        // A real pause empties the window.
        for _ in 0..QUIET_TICKS {
            analyser.fall();
        }
        assert!(analyser.ring.iter().all(|sample| *sample == 0.0));
    }

    /// Capture ends when asked even with no output device at all, which is
    /// what Windows reports while every speaker and headset is disconnected.
    #[test]
    #[ignore = "opens the real default output device"]
    fn live_capture_stops_when_asked_with_or_without_a_device() {
        let stop = AtomicBool::new(false);
        let mut sent = 0;
        let started = Instant::now();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(500));
                stop.store(true, Ordering::SeqCst);
            });
            listen(&stop, |_| {
                sent += 1;
                true
            });
        });
        eprintln!("frames sent in half a second: {sent}");
        assert!(started.elapsed() < RETRY * 2, "a stop is noticed within a retry wait");
    }

    /// Needs speakers or headphones connected. Prints what one second of them
    /// sounded like; play something first to see the bands move.
    #[test]
    #[ignore = "needs a connected output device"]
    fn live_loopback_opens_the_default_device_and_reads_it() {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().unwrap() };
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).unwrap() };
        let stream = open(&enumerator)
            .expect("no default output device: connect speakers or headphones")
            .expect("a mix format this reads");
        eprintln!("device {} format {:?}", stream.device_id, stream.format);
        assert_eq!(default_device_id(&enumerator).unwrap(), stream.device_id);
        let mut analyser = Analyser::new();
        let mut packets = 0;
        let mut loudest = [0u8; BANDS];
        for _ in 0..60 {
            if drain(&stream, &mut analyser).unwrap() {
                packets += 1;
                let levels = analyser.levels(stream.format.rate);
                for (top, level) in loudest.iter_mut().zip(levels) {
                    *top = (*top).max(level);
                }
            }
            std::thread::sleep(TICK);
        }
        eprintln!("ticks with sound: {packets}/60, loudest per band: {loudest:?}");
    }

    #[test]
    fn a_new_sound_shows_at_once_rather_than_easing_in() {
        let mut analyser = Analyser::new();
        analyser.push(&tone(1_000.0, 0.5), 1, |value| value);
        assert!(analyser.levels(RATE)[band_of(1_000.0)] > 200);
    }
}
