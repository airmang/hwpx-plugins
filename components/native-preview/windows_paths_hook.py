# SPDX-License-Identifier: Apache-2.0
"""Keep native extension loads inside long, verified Windows helper paths."""
import importlib.machinery
import os
import sys


def extended(path):
    value = os.path.abspath(path)
    if value.startswith('\\\\?\\'):
        return value
    return ('\\\\?\\UNC\\' + value[2:]) if value.startswith('\\\\') else ('\\\\?\\' + value)


class WindowsExtensionPaths:
    @classmethod
    def find_spec(cls, fullname, path=None, target=None):
        spec = importlib.machinery.PathFinder.find_spec(fullname, path, target)
        if spec is None and path:
            spec = importlib.machinery.PathFinder.find_spec(fullname, [extended(p) for p in path], target)
        if spec is not None and isinstance(spec.loader, importlib.machinery.ExtensionFileLoader):
            spec.origin = extended(spec.origin)
            spec.loader = importlib.machinery.ExtensionFileLoader(fullname, spec.origin)
            return spec
        return None


if os.name == 'nt':
    sys.meta_path.insert(0, WindowsExtensionPaths)
