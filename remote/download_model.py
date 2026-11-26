from modelscope import snapshot_download

path = snapshot_download(
    "OpenBMB/VoxCPM2",
    local_dir="/opt/voxcpm2/models/VoxCPM2",
)
print("DOWNLOAD_DONE", path, flush=True)
