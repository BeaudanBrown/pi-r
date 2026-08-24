summarise_groups <- function(input, value_col) {
  local_mean <- function(x) {
    mean(x, na.rm = TRUE)
  }

  input[, .(result = local_mean(get(value_col))), by = group]
}

write_result <- function(table, output_path) {
  saveRDS(table, output_path)
  output_path
}
