on run argv
    set outputDirectory to item 1 of argv
    set previewDirectory to item 2 of argv
    set documentNames to {"4차_프로젝트_기획서", "4차_프로젝트_결과_보고서"}
    tell application "Microsoft Word"
        repeat with documentName in documentNames
            set docxPath to outputDirectory & "/" & documentName & ".docx"
            set pdfPath to previewDirectory & "/" & documentName & ".pdf"
            open file name docxPath
            set deliverableDocument to active document
            repaginate deliverableDocument
            repeat with documentField in (get fields of deliverableDocument)
                update field documentField
            end repeat
            repeat with contentsTable in (get tables of contents of deliverableDocument)
                update contentsTable
            end repeat
            repaginate deliverableDocument
            save deliverableDocument
            save as deliverableDocument file name pdfPath file format format PDF
            close deliverableDocument saving no
        end repeat
    end tell
    return "Word pagination, contents fields, DOCX save and PDF export completed."
end run
