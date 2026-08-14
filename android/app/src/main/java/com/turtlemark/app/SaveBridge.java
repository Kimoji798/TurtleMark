package com.turtlemark.app;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 网页处理结果的保存桥：JS 把文件分块以 base64 传入，
 * 本类写入系统「下载」目录（Android 10+ 使用 MediaStore）。
 */
public class SaveBridge {

    private final Context context;
    private FileOutputStream fos;
    private File tempFile;
    private String fileName;

    public SaveBridge(Context context) {
        this.context = context.getApplicationContext();
    }

    @JavascriptInterface
    public void startSave(String name, int length) {
        try {
            fileName = name;
            tempFile = new File(context.getCacheDir(), "tm_" + System.currentTimeMillis() + ".tmp");
            fos = new FileOutputStream(tempFile);
        } catch (Exception e) {
            showToast("保存失败: " + e.getMessage());
        }
    }

    @JavascriptInterface
    public void appendChunk(String base64) {
        try {
            if (fos == null) return;
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            fos.write(bytes);
        } catch (Exception e) {
            showToast("保存失败: " + e.getMessage());
        }
    }

    @JavascriptInterface
    public void finishSave() {
        try {
            if (fos != null) {
                fos.flush();
                fos.close();
                fos = null;
            }
            if (Build.VERSION.SDK_INT >= 29) {
                saveToMediaStore();
            } else {
                File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) dir = context.getCacheDir();
                File dest = new File(dir, fileName);
                copy(tempFile, dest);
                showToast("已保存到: " + dest.getAbsolutePath());
            }
        } catch (Exception e) {
            showToast("保存失败: " + e.getMessage());
        } finally {
            if (tempFile != null) tempFile.delete();
        }
    }

    private void saveToMediaStore() throws Exception {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
        values.put(MediaStore.Downloads.MIME_TYPE, guessMime(fileName));
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        Uri uri = context.getContentResolver().insert(
                MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new Exception("无法创建文件");
        try (InputStream in = new FileInputStream(tempFile);
             OutputStream out = context.getContentResolver().openOutputStream(uri)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        showToast("已保存到系统「下载」文件夹");
    }

    private static String guessMime(String name) {
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".mp4")) return "video/mp4";
        if (name.endsWith(".webm")) return "video/webm";
        return "application/octet-stream";
    }

    private static void copy(File src, File dst) throws Exception {
        try (InputStream in = new FileInputStream(src);
             OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private void showToast(String msg) {
        new Handler(Looper.getMainLooper()).post(() ->
                Toast.makeText(context, msg, Toast.LENGTH_LONG).show());
    }
}
