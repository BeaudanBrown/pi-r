suppressPackageStartupMessages(library(jsonlite))

summary_script <- Sys.getenv("PI_R_VALUE_SUMMARY_SCRIPT", unset = "")
if (!nzchar(summary_script) || !file.exists(summary_script)) stop("PI_R_VALUE_SUMMARY_SCRIPT is unavailable")
source(summary_script, local = TRUE)

key_profile <- function(column, name) {
  missing <- sum(is.na(column))
  unique_count <- data.table::uniqueN(column, na.rm = FALSE)
  list(
    name = name,
    rows = length(column),
    missing = missing,
    unique = unique_count,
    duplicateRows = length(column) - unique_count
  )
}

inspect_data <- function(request) {
  path <- request$path
  requested_columns <- unique(unlist(request$columns %||% character(), use.names = FALSE))
  key <- request$key %||% NULL
  schema_sample <- data.table::fread(path, nrows = 100L, showProgress = FALSE)
  all_names <- names(schema_sample)
  offset <- max(0L, as.integer(request$columnOffset %||% 0L))
  limit <- min(50L, max(1L, as.integer(request$columnLimit %||% 20L)))
  start <- offset + 1L
  page_names <- if (start > length(all_names)) character() else head(all_names[seq.int(start, length(all_names))], limit)
  selected_existing <- intersect(requested_columns, all_names)
  key_existing <- if (!is.null(key) && key %in% all_names) key else character()
  scan_names <- unique(c(selected_existing, key_existing))
  if (!length(scan_names) && length(all_names)) scan_names <- all_names[[1L]]
  scanned <- if (length(scan_names)) {
    data.table::fread(path, select = scan_names, showProgress = FALSE)
  } else {
    data.table::data.table()
  }
  summaries <- unname(lapply(selected_existing, function(name) pi_r_column_summary(scanned[[name]], name)))
  profile <- if (length(key_existing)) key_profile(scanned[[key]], key) else NULL
  overlap <- NULL
  compare_path <- request$comparePath %||% NULL
  if (!is.null(compare_path) && length(key_existing)) {
    compare_schema <- data.table::fread(compare_path, nrows = 0L, showProgress = FALSE)
    if (!(key %in% names(compare_schema))) {
      overlap <- list(error = list(
        code = "MISSING_COMPARISON_KEY",
        message = paste("Comparison file does not contain key column:", key),
        recoverable = TRUE
      ))
    } else {
      compare_key <- data.table::fread(compare_path, select = key, showProgress = FALSE)[[key]]
      left_unique <- unique(scanned[[key]])
      right_unique <- unique(compare_key)
      overlap <- list(
        comparisonPath = compare_path,
        comparison = key_profile(compare_key, key),
        uniqueIntersection = length(intersect(left_unique, right_unique)),
        onlyPrimary = length(setdiff(left_unique, right_unique)),
        onlyComparison = length(setdiff(right_unique, left_unique)),
        error = NULL
      )
    }
  }
  list(
    path = path,
    bytes = unname(file.info(path)$size),
    rows = nrow(scanned),
    schema = list(
      total = length(all_names),
      offset = offset,
      returned = length(page_names),
      nextOffset = if (offset + length(page_names) < length(all_names)) offset + length(page_names) else NULL,
      items = unname(lapply(page_names, function(name) list(
        name = substr(name, 1L, 200L),
        class = as.list(substr(head(class(schema_sample[[name]]), 4L), 1L, 100L))
      )))
    ),
    selected = summaries,
    missingColumns = as.list(substr(setdiff(requested_columns, all_names), 1L, 200L)),
    key = if (is.null(key)) NULL else if (length(key_existing)) profile else list(
      name = key,
      error = list(code = "MISSING_KEY", message = paste("Primary file does not contain key column:", key), recoverable = TRUE)
    ),
    overlap = overlap,
    error = NULL
  )
}

request_line <- readLines(file("stdin", open = "r"), n = 1L, warn = FALSE)
request <- tryCatch(fromJSON(request_line, simplifyVector = FALSE), error = identity)
result <- if (inherits(request, "error")) {
  list(path = NULL, error = list(code = "INVALID_DATA_INSPECTION_REQUEST", message = conditionMessage(request), recoverable = TRUE))
} else tryCatch(inspect_data(request), error = function(condition) list(
  path = request$path %||% NULL,
  error = list(code = "DATA_INSPECTION_FAILED", message = conditionMessage(condition), recoverable = TRUE)
))
cat("PI_R_RESULT:", toJSON(result, auto_unbox = TRUE, null = "null", na = "null", digits = NA), "\n", sep = "")
