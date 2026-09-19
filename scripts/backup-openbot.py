#!/usr/bin/env python3
"""Compatibility entrypoint for existing backup jobs."""
import runpy
from pathlib import Path
runpy.run_path(str(Path(__file__).with_name("backup-ownbot.py")), run_name="__main__")
