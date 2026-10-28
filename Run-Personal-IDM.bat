@echo off
title Personal IDM - Internet Download Manager
cd /d "%~dp0\personal-idm"
set NODE_OPTIONS=--use-system-ca
npm start
