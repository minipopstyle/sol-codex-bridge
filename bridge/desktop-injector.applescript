on run
  delay 1.2
  tell application "System Events"
    set targetProcess to missing value
    repeat with attempt from 1 to 40
      repeat with p in application processes
        try
          set currentBundleId to bundle identifier of p
          if (frontmost of p) and (currentBundleId is "com.openai.codex" or currentBundleId is "com.openai.chat") then
            set targetProcess to p
            exit repeat
          end if
        end try
      end repeat
      if targetProcess is not missing value then exit repeat
      delay 0.1
    end repeat
    if targetProcess is missing value then error "CODEX_PROCESS_NOT_FOUND"
    tell targetProcess to set frontmost to true
    delay 0.15

    set targetField to missing value
    repeat with attempt from 1 to 35
      set bestY to -1
      try
        tell targetProcess to set allElements to entire contents of front window
        repeat with el in allElements
          try
            if role of el is "AXTextArea" or role of el is "AXTextField" then
              set canUse to true
              try
                if enabled of el is false then set canUse to false
              end try
              if canUse then
                set yy to item 2 of position of el
                if yy is greater than or equal to bestY then
                  set bestY to yy
                  set targetField to el
                end if
              end if
            end if
          end try
        end repeat
      end try
      if targetField is not missing value then exit repeat
      delay 0.12
    end repeat
    if targetField is missing value then error "CODEX_COMPOSER_NOT_FOUND"
    try
      set focused of targetField to true
    end try
    delay 0.12
    keystroke "a" using {command down}
    delay 0.05
    keystroke "v" using {command down}
    delay 0.18
    key code 36
  end tell
end run
