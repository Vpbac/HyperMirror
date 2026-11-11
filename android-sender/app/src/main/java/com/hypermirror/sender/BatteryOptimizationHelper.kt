package com.hypermirror.sender

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.Window

object BatteryOptimizationHelper {
    private const val TAG = "BatteryOptimization"

    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            pm?.isIgnoringBatteryOptimizations(context.packageName) ?: true
        } else {
            true
        }
    }

    @SuppressLint("BatteryLife")
    fun requestIgnoreBatteryOptimizations(activity: Activity) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = activity.getSystemService(Context.POWER_SERVICE) as? PowerManager
            if (pm != null && !pm.isIgnoringBatteryOptimizations(activity.packageName)) {
                try {
                    val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:${activity.packageName}")
                    }
                    activity.startActivity(intent)
                    Log.i(TAG, "Requested ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS for ${activity.packageName}")
                    return
                } catch (e: Exception) {
                    Log.w(TAG, "Direct ignore battery optimization request failed: ${e.message}")
                }

                // Fallback to general battery saver settings
                try {
                    val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    activity.startActivity(intent)
                } catch (e: Exception) {
                    Log.w(TAG, "Fallback battery optimization settings failed: ${e.message}")
                }
            }
        }
    }

    fun isXiaomiOrPocoDevice(): Boolean {
        val manufacturer = Build.MANUFACTURER.lowercase()
        val brand = Build.BRAND.lowercase()
        return manufacturer.contains("xiaomi") || manufacturer.contains("poco") ||
                brand.contains("xiaomi") || brand.contains("poco") ||
                brand.contains("redmi")
    }

    fun openXiaomiBackgroundSettings(context: Context): Boolean {
        // Xiaomi HyperOS / MIUI specific background manager activities
        val intents = listOf(
            // HyperOS / MIUI Autostart manager
            Intent().setComponent(
                ComponentName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")
            ),
            // HyperOS Powerkeeper (No restrictions / Battery saver)
            Intent().setComponent(
                ComponentName("com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity")
            ).apply {
                putExtra("package_name", context.packageName)
                putExtra("package_label", "HyperMirror Pro")
            },
            // Application details settings as final fallback
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
        )

        for (intent in intents) {
            try {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                Log.i(TAG, "Opened Xiaomi/HyperOS background settings: ${intent.component}")
                return true
            } catch (_: Exception) {
            }
        }
        return false
    }

    fun requestDisplayHighRefreshRate(window: Window) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                val modes = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    window.context.display?.supportedModes
                } else {
                    @Suppress("DEPRECATION")
                    window.windowManager?.defaultDisplay?.supportedModes
                }
                val highRefreshMode = modes?.filter { it.refreshRate >= 119.0f }
                    ?.maxByOrNull { it.refreshRate }
                if (highRefreshMode != null) {
                    val lp = window.attributes
                    lp.preferredDisplayModeId = highRefreshMode.modeId
                    window.attributes = lp
                    Log.i(TAG, "Activated high refresh rate mode: ${highRefreshMode.refreshRate}Hz (mode ${highRefreshMode.modeId})")
                }
            } catch (e: Exception) {
                Log.w(TAG, "Could not set preferred display mode: ${e.message}")
            }
        }
    }
}
