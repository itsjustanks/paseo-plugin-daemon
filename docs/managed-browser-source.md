# Managed browser source

The workspace browser adapts Omer Cohen's MIT-licensed paseo-shared-browser at
`daed6eb12f4156ca392f71c48e7a9ccca231ae8c`.

Source: https://github.com/omercnet/paseo-plugins/tree/daed6eb12f4156ca392f71c48e7a9ccca231ae8c/paseo-shared-browser

Full notices are retained in `server/managed-browser/LICENSE.txt`,
`client/managed-browser/LICENSE.txt` and `shared/managed-browser/LICENSE.txt`.

Local adaptations isolate namespaces, use JPEG only, bound IPC replies, sanitize failures,
manage native viewer visibility and stage browser-only Node privately. Existing external
browser observation and Hosts process policies retain their separate implementation.
