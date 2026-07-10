import AudioToolbox
import CoreAudio
import Foundation
import os

@MainActor
final class SystemVolumeController {
    private let log = Log.make(for: "SystemVolume")

    var onVolumeChanged: ((Int) -> Void)?
    private(set) var lastKnownPercent: Int?

    private var deviceID = AudioObjectID(kAudioObjectUnknown)
    private var listeningDeviceID: AudioObjectID?
    private var started = false

    private static var volumeAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )

    private static var defaultOutputAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    private lazy var volumeListener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
        Task { @MainActor [weak self] in
            guard let self, let percent = self.currentPercent() else { return }
            self.lastKnownPercent = percent
            self.onVolumeChanged?(percent)
        }
    }

    private lazy var defaultDeviceListener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in
        Task { @MainActor [weak self] in
            self?.refreshDefaultDevice()
        }
    }

    func start() {
        guard !started else { return }
        started = true
        AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &Self.defaultOutputAddress,
            DispatchQueue.main,
            defaultDeviceListener
        )
        refreshDefaultDevice()
    }

    func stop() {
        guard started else { return }
        started = false
        AudioObjectRemovePropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &Self.defaultOutputAddress,
            DispatchQueue.main,
            defaultDeviceListener
        )
        detachVolumeListener()
        deviceID = AudioObjectID(kAudioObjectUnknown)
    }

    func currentPercent() -> Int? {
        guard let scalar = currentScalar() else { return nil }
        return Int((scalar * 100).rounded())
    }

    func step(by delta: Float32) {
        guard deviceID != kAudioObjectUnknown, let scalar = currentScalar() else {
            log.warning("Volume step ignored: output device has no controllable volume")
            return
        }
        var next = min(max(scalar + delta, 0), 1)
        let status = AudioObjectSetPropertyData(
            deviceID, &Self.volumeAddress, 0, nil,
            UInt32(MemoryLayout<Float32>.size), &next
        )
        if status != noErr {
            log.error("Failed to set output volume: OSStatus \(status, privacy: .public)")
        }
    }

    private func currentScalar() -> Float32? {
        guard deviceID != kAudioObjectUnknown,
              AudioObjectHasProperty(deviceID, &Self.volumeAddress) else { return nil }
        var value: Float32 = 0
        var size = UInt32(MemoryLayout<Float32>.size)
        let status = AudioObjectGetPropertyData(deviceID, &Self.volumeAddress, 0, nil, &size, &value)
        guard status == noErr else { return nil }
        return value
    }

    private func refreshDefaultDevice() {
        var newDevice = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &Self.defaultOutputAddress, 0, nil, &size, &newDevice
        )
        guard status == noErr else {
            log.error("Failed to resolve default output device: OSStatus \(status, privacy: .public)")
            return
        }
        guard newDevice != deviceID else { return }

        detachVolumeListener()
        deviceID = newDevice
        if newDevice != kAudioObjectUnknown, AudioObjectHasProperty(newDevice, &Self.volumeAddress) {
            AudioObjectAddPropertyListenerBlock(newDevice, &Self.volumeAddress, DispatchQueue.main, volumeListener)
            listeningDeviceID = newDevice
        }
        if let percent = currentPercent() {
            lastKnownPercent = percent
            onVolumeChanged?(percent)
        }
    }

    private func detachVolumeListener() {
        if let previous = listeningDeviceID {
            AudioObjectRemovePropertyListenerBlock(previous, &Self.volumeAddress, DispatchQueue.main, volumeListener)
            listeningDeviceID = nil
        }
    }
}
