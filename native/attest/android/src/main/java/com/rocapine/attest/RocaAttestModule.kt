package com.rocapine.attest

import android.util.Base64
import com.google.android.gms.tasks.Task
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityException
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenProvider
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest
import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.MessageDigest

/**
 * Play Integrity (standard requests) for the Rocalytics SDK.
 *
 * Rejections carry `E_PI_<NAME>` for a StandardIntegrityException, NAME being the
 * StandardIntegrityErrorCode constant's name, and `E_ATTEST_UNKNOWN` otherwise.
 * The SDK classifies provider failures by this code.
 */
class RocaAttestModule : Module() {
  @Volatile private var provider: StandardIntegrityTokenProvider? = null
  @Volatile private var cloudProjectNumber: Long? = null

  override fun definition() = ModuleDefinition {
    Name("RocaAttest")

    // Devices without Play surface through E_PI_* errors from prepare / requestToken.
    AsyncFunction("isSupported") { true }

    AsyncFunction("prepare") { cloudProjectNumber: String, promise: Promise ->
      val number = cloudProjectNumber.trim().toLongOrNull()
      if (number == null) {
        promise.reject(
          "E_PI_CLOUD_PROJECT_NUMBER_IS_INVALID",
          "cloud project number must be an integer, got \"$cloudProjectNumber\"",
          null,
        )
        return@AsyncFunction
      }
      prepareProvider(number, onSuccess = { promise.resolve(null) }, onFailure = { reject(promise, it) })
    }

    AsyncFunction("requestToken") { binding: String, promise: Promise ->
      val hash = requestHash(binding)
      val current = provider
      if (current == null) {
        promise.reject(
          "E_PI_INTEGRITY_TOKEN_PROVIDER_INVALID",
          "requestToken called before prepare",
          null,
        )
        return@AsyncFunction
      }
      request(current, hash, onSuccess = { promise.resolve(it) }) { error ->
        val number = cloudProjectNumber
        if (errorCode(error) == StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID && number != null) {
          // The provider expired: prepare again with the last project number and retry once.
          prepareProvider(number, onFailure = { reject(promise, it) }) { fresh ->
            request(fresh, hash, onSuccess = { promise.resolve(it) }) { reject(promise, it) }
          }
        } else {
          reject(promise, error)
        }
      }
    }
  }

  private fun prepareProvider(
    number: Long,
    onFailure: (Exception) -> Unit,
    onSuccess: (StandardIntegrityTokenProvider) -> Unit,
  ) {
    val context = appContext.reactContext?.applicationContext
    if (context == null) {
      onFailure(IllegalStateException("no React context"))
      return
    }
    val request = PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(number).build()
    IntegrityManagerFactory.createStandard(context).prepareIntegrityToken(request).handle(onFailure) {
      provider = it
      cloudProjectNumber = number
      onSuccess(it)
    }
  }

  private fun request(
    provider: StandardIntegrityTokenProvider,
    hash: String,
    onSuccess: (String) -> Unit,
    onFailure: (Exception) -> Unit,
  ) {
    val request = StandardIntegrityTokenRequest.builder().setRequestHash(hash).build()
    provider.request(request).handle(onFailure) { onSuccess(it.token()) }
  }

  private fun reject(promise: Promise, error: Exception) {
    val name = (error as? StandardIntegrityException)?.let { errorName(it.errorCode) }
    promise.reject(name?.let { "E_PI_$it" } ?: "E_ATTEST_UNKNOWN", error.message ?: error.toString(), error)
  }
}

private fun <T> Task<T>.handle(onFailure: (Exception) -> Unit, onSuccess: (T) -> Unit) {
  addOnSuccessListener { onSuccess(it) }
  addOnFailureListener { onFailure(it) }
}

private fun errorCode(error: Exception): Int? = (error as? StandardIntegrityException)?.errorCode

/** requestHash = base64url(SHA-256(binding UTF-8)), no padding: 43 chars. */
internal fun requestHash(binding: String): String {
  val digest = MessageDigest.getInstance("SHA-256").digest(binding.toByteArray(Charsets.UTF_8))
  return Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}

/** The StandardIntegrityErrorCode constant's name; null for a code this version does not define. */
internal fun errorName(code: Int): String? = when (code) {
  StandardIntegrityErrorCode.NO_ERROR -> "NO_ERROR"
  StandardIntegrityErrorCode.API_NOT_AVAILABLE -> "API_NOT_AVAILABLE"
  StandardIntegrityErrorCode.PLAY_STORE_NOT_FOUND -> "PLAY_STORE_NOT_FOUND"
  StandardIntegrityErrorCode.NETWORK_ERROR -> "NETWORK_ERROR"
  StandardIntegrityErrorCode.APP_NOT_INSTALLED -> "APP_NOT_INSTALLED"
  StandardIntegrityErrorCode.PLAY_SERVICES_NOT_FOUND -> "PLAY_SERVICES_NOT_FOUND"
  StandardIntegrityErrorCode.APP_UID_MISMATCH -> "APP_UID_MISMATCH"
  StandardIntegrityErrorCode.TOO_MANY_REQUESTS -> "TOO_MANY_REQUESTS"
  StandardIntegrityErrorCode.CANNOT_BIND_TO_SERVICE -> "CANNOT_BIND_TO_SERVICE"
  StandardIntegrityErrorCode.GOOGLE_SERVER_UNAVAILABLE -> "GOOGLE_SERVER_UNAVAILABLE"
  StandardIntegrityErrorCode.PLAY_STORE_VERSION_OUTDATED -> "PLAY_STORE_VERSION_OUTDATED"
  StandardIntegrityErrorCode.PLAY_SERVICES_VERSION_OUTDATED -> "PLAY_SERVICES_VERSION_OUTDATED"
  StandardIntegrityErrorCode.CLOUD_PROJECT_NUMBER_IS_INVALID -> "CLOUD_PROJECT_NUMBER_IS_INVALID"
  StandardIntegrityErrorCode.REQUEST_HASH_TOO_LONG -> "REQUEST_HASH_TOO_LONG"
  StandardIntegrityErrorCode.CLIENT_TRANSIENT_ERROR -> "CLIENT_TRANSIENT_ERROR"
  StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID -> "INTEGRITY_TOKEN_PROVIDER_INVALID"
  StandardIntegrityErrorCode.INTERNAL_ERROR -> "INTERNAL_ERROR"
  else -> null
}
