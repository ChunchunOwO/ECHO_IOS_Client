Pod::Spec.new do |s|
  s.name           = 'EchoAudioDsp'
  s.version        = '0.1.0'
  s.summary        = 'Native iOS DSP playback engine for ECHO iPhone.'
  s.description    = 'AVAudioEngine playback with EQ and loudness processing for local and cached streamed audio.'
  s.author         = 'ECHO iPhone'
  s.homepage       = 'https://github.com/Moekotori/ECHO'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
end
