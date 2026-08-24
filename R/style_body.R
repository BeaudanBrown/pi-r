args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 2L)

input <- readLines(args[[1L]], warn = FALSE, encoding = "UTF-8")
styled <- styler::style_text(input, strict = TRUE)
writeLines(styled, args[[2L]], useBytes = TRUE)
