; Older clients launch upgrades without /S. Keep manual installs interactive.
!macro customInit
  ${if} ${isUpdated}
    SetSilent silent
  ${endif}
!macroend
