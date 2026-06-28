"""FBEM bridge — local Facebook native-composer upload bridge.

Bridges a Chrome MV3 extension over WebSocket (:9224) + HTTP callback (:47102).
The extension's crawler snapshots genuine native upload requests when the user
posts by hand; the bridge folds those into a self-healing replay template that
`post_reel` / `post_photos` reproduce with fresh tokens.

This is a LOCAL CONTENT TOOL — loopback-only, never network-reachable.
"""
