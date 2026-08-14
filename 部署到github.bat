@echo off
title TurtleMark Deploy
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
