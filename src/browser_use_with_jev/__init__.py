"""Jev decision routing for the upstream Browser Use agent."""

from importlib import import_module

__all__ = ["Candidate", "HostModel", "JevAgent", "JevClient", "JevError", "RoutingStats"]


def __getattr__(name):
    modules = {
        "Candidate": "actions",
        "JevAgent": "agent",
        "RoutingStats": "agent",
        "HostModel": "host",
        "JevClient": "jev",
        "JevError": "jev",
    }
    if name not in modules:
        raise AttributeError(name)
    value = getattr(import_module(f".{modules[name]}", __name__), name)
    globals()[name] = value
    return value
