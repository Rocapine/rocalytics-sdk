import CryptoKit
import DeviceCheck
import ExpoModulesCore

private let storedKeyIdDefaultsKey = "rocalytics.attest.keyId"

/// Rejects with `E_DC_<n>` for a DeviceCheck error (DCError code n), `E_ATTEST_UNKNOWN` otherwise.
/// The Rocalytics SDK classifies provider failures by this code.
final class AttestException: Exception {
  private let errorCode: String
  private let errorReason: String

  init(_ error: Error?) {
    let nsError = error.map { $0 as NSError }
    if let nsError = nsError, nsError.domain == DCErrorDomain {
      errorCode = "E_DC_\(nsError.code)"
    } else {
      errorCode = "E_ATTEST_UNKNOWN"
    }
    errorReason = nsError?.localizedDescription ?? "App Attest returned no result"
    super.init()
  }

  override var code: String { errorCode }
  override var reason: String { errorReason }
}

/// The App Attest client-data hash: SHA-256 of the binding string's UTF-8 bytes.
private func clientDataHash(_ binding: String) -> Data {
  Data(SHA256.hash(data: Data(binding.utf8)))
}

public class RocaAttestModule: Module {
  public func definition() -> ModuleDefinition {
    Name("RocaAttest")

    AsyncFunction("isSupported") { () -> Bool in
      DCAppAttestService.shared.isSupported
    }

    AsyncFunction("generateKey") { (promise: Promise) in
      DCAppAttestService.shared.generateKey { keyId, error in
        if let keyId = keyId {
          promise.resolve(keyId)
        } else {
          promise.reject(AttestException(error))
        }
      }
    }

    AsyncFunction("attestKey") { (keyId: String, binding: String, promise: Promise) in
      DCAppAttestService.shared.attestKey(keyId, clientDataHash: clientDataHash(binding)) { attestation, error in
        if let attestation = attestation {
          promise.resolve(attestation.base64EncodedString())
        } else {
          promise.reject(AttestException(error))
        }
      }
    }

    AsyncFunction("generateAssertion") { (keyId: String, binding: String, promise: Promise) in
      DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: clientDataHash(binding)) { assertion, error in
        if let assertion = assertion {
          promise.resolve(assertion.base64EncodedString())
        } else {
          promise.reject(AttestException(error))
        }
      }
    }

    AsyncFunction("getStoredKeyId") { () -> String? in
      UserDefaults.standard.string(forKey: storedKeyIdDefaultsKey)
    }

    AsyncFunction("setStoredKeyId") { (keyId: String?) in
      if let keyId = keyId {
        UserDefaults.standard.set(keyId, forKey: storedKeyIdDefaultsKey)
      } else {
        UserDefaults.standard.removeObject(forKey: storedKeyIdDefaultsKey)
      }
    }
  }
}
