args <- commandArgs(trailingOnly = TRUE)
stopifnot(length(args) == 2L)
path <- args[[1L]]
max_rows <- as.integer(args[[2L]])

result <- tryCatch({
  data <- data.table::fread(path, nrows = max_rows, showProgress = FALSE)
  list(
    path = path,
    bytes = unname(file.info(path)$size),
    sampledRows = nrow(data),
    columns = lapply(names(data), function(name) list(
      name = name,
      class = head(class(data[[name]]), 4L),
      missing = sum(is.na(data[[name]]))
    )),
    head = head(data, 10L),
    truncated = nrow(data) >= max_rows,
    error = NULL
  )
}, error = function(condition) list(
  path = path,
  error = list(
    code = "DATA_INSPECTION_FAILED",
    message = conditionMessage(condition),
    recoverable = TRUE
  )
))
cat("PI_R_RESULT:", jsonlite::toJSON(result, auto_unbox = TRUE, null = "null", dataframe = "rows", digits = NA), "\n", sep = "")
