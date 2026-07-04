import os.path

app = defines["app"]
appname = os.path.basename(app)
bg = defines.get("bg", "")

files = [app]
symlinks = {"Applications": "/Applications"}
hide = [".background.tiff"]
hide_extensions = [appname]

window_rect = ((200, 120), (660, 426))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_pathbar = False
show_sidebar = False
show_toolbar = False
include_icon_view_settings = True
arrange_by = None
icon_size = 128
text_size = 12
format = "UDZO"

icon_locations = {
    appname: (189, 252),
    "Applications": (471, 252),
}

if bg:
    background = bg
