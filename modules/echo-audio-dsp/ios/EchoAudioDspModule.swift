import AVFoundation
import ExpoModulesCore

private final class DspPlaybackEngine {
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let eq = AVAudioUnitEQ(numberOfBands: 5)
  private let dynamics = AVAudioUnitDynamicsProcessor()
  private var audioFile: AVAudioFile?
  private var sampleRate: Double = 44_100
  private var durationSeconds: Double = 0
  private var scheduledStartFrame: AVAudioFramePosition = 0
  private var offsetSeconds: Double = 0
  private var playing = false
  private var finished = false
  private var configured = false

  init() {
    configureEqBands([0, 0, 0, 0, 0])
    dynamics.bypass = true
    dynamics.threshold = -18
    dynamics.headRoom = 5
    dynamics.expansionRatio = 1
    dynamics.expansionThreshold = -48
    dynamics.attackTime = 0.008
    dynamics.releaseTime = 0.18
    dynamics.masterGain = 2
  }

  func playFile(uri: String, positionMs: Double, volume: Double, gains: [Double], loudnessEnabled: Bool) throws {
    guard let url = URL(string: uri), url.isFileURL else {
      throw DspError.invalidUri
    }

    try configureAudioSession()
    let file = try AVAudioFile(forReading: url)
    audioFile = file
    sampleRate = file.processingFormat.sampleRate
    durationSeconds = sampleRate > 0 ? Double(file.length) / sampleRate : 0
    offsetSeconds = max(0, min(positionMs / 1000, durationSeconds))
    scheduledStartFrame = AVAudioFramePosition(offsetSeconds * sampleRate)
    finished = false

    configureGraph(format: file.processingFormat)
    configureEqBands(gains)
    dynamics.bypass = !loudnessEnabled
    player.volume = Float(max(0, min(1, volume)))

    player.stop()
    player.reset()
    scheduleCurrentFile(shouldMarkFinished: true)

    if !engine.isRunning {
      try engine.start()
    }
    player.play()
    playing = true
  }

  func pause() {
    guard playing else { return }
    offsetSeconds = currentTime()
    player.pause()
    playing = false
  }

  func resume() throws {
    guard audioFile != nil else { return }
    if finished {
      try seekTo(seconds: 0)
    }
    if !engine.isRunning {
      try engine.start()
    }
    player.play()
    playing = true
    finished = false
  }

  func stop() {
    player.stop()
    player.reset()
    playing = false
    finished = false
    offsetSeconds = 0
    scheduledStartFrame = 0
  }

  func seekTo(seconds: Double) throws {
    guard audioFile != nil else { return }
    let wasPlaying = playing
    offsetSeconds = max(0, min(seconds, durationSeconds))
    scheduledStartFrame = AVAudioFramePosition(offsetSeconds * sampleRate)
    finished = false
    player.stop()
    player.reset()
    scheduleCurrentFile(shouldMarkFinished: true)
    if wasPlaying {
      if !engine.isRunning {
        try engine.start()
      }
      player.play()
    }
    playing = wasPlaying
  }

  func setVolume(_ volume: Double) {
    player.volume = Float(max(0, min(1, volume)))
  }

  func setEq(gains: [Double]) {
    configureEqBands(gains)
  }

  func setLoudness(_ enabled: Bool) {
    dynamics.bypass = !enabled
  }

  func status() -> [String: Any] {
    [
      "currentTime": currentTime(),
      "didJustFinish": finished,
      "duration": durationSeconds,
      "playing": playing,
      "volume": Double(player.volume)
    ]
  }

  private func configureAudioSession() throws {
    #if os(iOS) || os(tvOS)
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playback, mode: .default, options: [])
    try session.setActive(true)
    #endif
  }

  private func configureGraph(format: AVAudioFormat) {
    if !configured {
      engine.attach(player)
      engine.attach(eq)
      engine.attach(dynamics)
      configured = true
    }

    engine.disconnectNodeOutput(player)
    engine.disconnectNodeOutput(eq)
    engine.disconnectNodeOutput(dynamics)
    engine.connect(player, to: eq, format: format)
    engine.connect(eq, to: dynamics, format: format)
    engine.connect(dynamics, to: engine.mainMixerNode, format: format)
  }

  private func scheduleCurrentFile(shouldMarkFinished: Bool) {
    guard let audioFile else { return }
    let startFrame = max(0, min(scheduledStartFrame, audioFile.length))
    let remainingFrames = max(0, audioFile.length - startFrame)
    guard remainingFrames > 0 else {
      playing = false
      finished = shouldMarkFinished
      return
    }

    player.scheduleSegment(
      audioFile,
      startingFrame: startFrame,
      frameCount: AVAudioFrameCount(min(Int64(UInt32.max), remainingFrames)),
      at: nil
    ) { [weak self] in
      DispatchQueue.main.async {
        guard let self else { return }
        self.offsetSeconds = self.durationSeconds
        self.playing = false
        self.finished = shouldMarkFinished
      }
    }
  }

  private func currentTime() -> Double {
    guard playing,
          let nodeTime = player.lastRenderTime,
          let playerTime = player.playerTime(forNodeTime: nodeTime),
          sampleRate > 0
    else {
      return max(0, min(offsetSeconds, durationSeconds))
    }

    let frame = scheduledStartFrame + AVAudioFramePosition(playerTime.sampleTime)
    return max(0, min(Double(frame) / sampleRate, durationSeconds))
  }

  private func configureEqBands(_ gains: [Double]) {
    let frequencies: [Float] = [60, 230, 910, 3600, 14_000]
    for (index, band) in eq.bands.enumerated() {
      band.filterType = .parametric
      band.frequency = frequencies[index]
      band.bandwidth = 1.1
      band.gain = Float(index < gains.count ? max(-12, min(12, gains[index])) : 0)
      band.bypass = false
    }
    eq.globalGain = 0
  }
}

private enum DspError: Error {
  case invalidUri
}

public final class EchoAudioDspModule: Module {
  private let playbackEngine = DspPlaybackEngine()

  public func definition() -> ModuleDefinition {
    Name("EchoAudioDsp")

    AsyncFunction("playFile") { (uri: String, positionMs: Double, volume: Double, gains: [Double], loudnessEnabled: Bool) in
      try self.playbackEngine.playFile(
        uri: uri,
        positionMs: positionMs,
        volume: volume,
        gains: gains,
        loudnessEnabled: loudnessEnabled
      )
    }

    AsyncFunction("pause") {
      self.playbackEngine.pause()
    }

    AsyncFunction("resume") {
      try self.playbackEngine.resume()
    }

    AsyncFunction("stop") {
      self.playbackEngine.stop()
    }

    AsyncFunction("seekTo") { (seconds: Double) in
      try self.playbackEngine.seekTo(seconds: seconds)
    }

    AsyncFunction("setVolume") { (volume: Double) in
      self.playbackEngine.setVolume(volume)
    }

    AsyncFunction("setEq") { (gains: [Double]) in
      self.playbackEngine.setEq(gains: gains)
    }

    AsyncFunction("setLoudness") { (enabled: Bool) in
      self.playbackEngine.setLoudness(enabled)
    }

    AsyncFunction("getStatus") { () -> [String: Any] in
      self.playbackEngine.status()
    }

    OnDestroy {
      self.playbackEngine.stop()
    }
  }
}
