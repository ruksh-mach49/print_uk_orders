import axios from "axios";
import fsp from "fs/promises";
import fs from "fs";
import { JWT } from "google-auth-library";
import { drive } from "@googleapis/drive";
import Bottleneck from "bottleneck";
import AWS from "aws-sdk";
const sns = new AWS.SNS({
  region: "eu-north-1", // Europe/Stockholm
});

const client_email2 = process.env.CLIENT_EMAIL;
const formatted_key2 = process.env.PRIVATE_KEY.replace(/\\n/g, "\n");
const root_folder_id = process.env.ROOT_FOLDER_ID4;
let client2;
let driveApi;
const LINNWORKS_APP_ID = process.env.LINNWORKS_APP_ID;
const LINNWORKS_APP_SECRET = process.env.LINNWORKS_APP_SECRET;
const LINNWORKS_API_TOKEN = process.env.LINNWORKS_API_TOKEN;
const BASE_URL = process.env.LINNWORKS_BASE_URL;
const M7_48 = process.env.EVRI_M7_48;
const ABS_EVRI_LINKED_NEXT_DAY = process.env.ABS_EVRI_LINKED_NEXT_DAY;
const UK_COUNTRY_ID = process.env.UK_COUNTRY_ID;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;

const limiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 500,
  reservoir: 120,
  reservoirRefreshAmount: 120,
  reservoirRefreshInterval: 60 * 1000,
});
const limiter2 = new Bottleneck({
  maxConcurrent: 1,
  minTime: 500,
  reservoir: 120,
  reservoirRefreshAmount: 120,
  reservoirRefreshInterval: 60 * 1000,
});
const updateItemLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 500,
  reservoir: 120,
  reservoirRefreshAmount: 120,
  reservoirRefreshInterval: 60 * 1000,
});
const updateCountryLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 500,
  reservoir: 120,
  reservoirRefreshAmount: 120,
  reservoirRefreshInterval: 60 * 1000,
});
const changeShippingMethodLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 500,
  reservoir: 120,
  reservoirRefreshAmount: 120,
  reservoirRefreshInterval: 60 * 1000,
});
const setOrderPackagingLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 500,
  reservoir: 120,
  reservoirRefreshAmount: 120,
  reservoirRefreshInterval: 60 * 1000,
});
const numOrderLimiter = new Bottleneck({
  maxConcurrent: 1,
  minTime: 333,
  reservoir: 180,
  reservoirRefreshAmount: 180,
  reservoirRefreshInterval: 60 * 1000,
});
const getNumOrderWrapper = handleRetries(
  numOrderLimiter.wrap(async (token, id) => {
    const res = await axios({
      url: `${BASE_URL}/api/Orders/GetOrderDetailsByNumOrderId?OrderId=${id}`,
      method: "GET",
      headers: {
        Authorization: token,
      },
    });
    if (res.status === 200) return res.data;
    return null;
  }),
);
const invoiceFolderPath = "./tmp/invoicePrinted";
let ukSingleOrders = {};
let ukDoubleOrders = [];
let sortedKeys = [];
let invoicePrintError = [];
let printError = [];
let pdfCount = 0;
const JerseyRegex = /^JE[1-5]/i;

async function authorize() {
  try {
    const getToken = handleRetries(async () => {
      return await axios({
        url: "https://api.linnworks.net/api/Auth/AuthorizeByApplication",
        method: "POST",
        data: {
          ApplicationId: LINNWORKS_APP_ID,
          ApplicationSecret: LINNWORKS_APP_SECRET,
          Token: LINNWORKS_API_TOKEN,
        },
      });
    });
    const res = await getToken();
    return res.data;
  } catch (err) {
    throw err;
  }
}

async function sleep(t) {
  return new Promise((r) => setTimeout(r, t));
}

function handleRetries(fn) {
  return async function (...args) {
    let attempt = 0;
    while (attempt < 2) {
      try {
        return await fn(...args);
      } catch (err) {
        attempt++;
        if (attempt >= 2) throw err;
        await sleep((attempt + 1) * 1000);
      }
    }
  };
}

function isAmazonShoes(order) {
  let isEligible = false;
  if (
    order.GeneralInfo.Status === 1 &&
    order.GeneralInfo.hasOwnProperty("InvoicePrintError") === false &&
    order.GeneralInfo.LabelError.trim().toLowerCase() === "" &&
    (order.GeneralInfo.hasOwnProperty("Marker")
      ? order.GeneralInfo.Marker !== 5
        ? true
        : false
      : false) &&
    order.GeneralInfo.InvoicePrinted === false &&
    order.GeneralInfo.HoldOrCancel === false &&
    order.GeneralInfo.LabelPrinted === false &&
    order.GeneralInfo.PickListPrinted === false &&
    order.GeneralInfo.Source.trim().toLowerCase().includes("amazon") === true &&
    order.GeneralInfo.ReceivedDate != null &&
    order.CustomerInfo.Address.Town.trim().toLowerCase() !== "unknown" &&
    order.Items.length > 0
  )
    isEligible = true;
  if (!isEligible) return false;
  const country = order.CustomerInfo.Address.Country.trim().toLowerCase();
  const postCode = order.CustomerInfo.Address.PostCode.trim().toLowerCase();
  if (
    country === "united kingdom" ||
    (country === "unknown" && postCode !== "unknown") ||
    country === "jersey" ||
    JerseyRegex.test(postCode)
  )
    return true;
  return false;
}

const getPkgCalc = handleRetries(
  limiter2.wrap(async (order, token) => {
    return await axios({
      url: `${BASE_URL}/api/Orders/GetOrderPackagingCalculation`,
      method: "POST",
      headers: {
        Authorization: token,
      },
      data: {
        pkOrderIds: [`${order.OrderId}`],
        Recalculate: false,
        SaveRecalculation: false,
      },
    });
  }),
);

async function changeItemObject(order, token) {
  for (let i = 0; i < order.Items.length; i++) {
    const item = order.Items[i];
    if (item.Title.trim() === "") {
      console.log(
        `item Title missing, for order: ${order.NumOrderId} and item: ${item.ItemId}`,
      );
      try {
        const updateItem = handleRetries(
          updateItemLimiter.wrap(async (item, token) => {
            const res1 = await axios({
              url: `${BASE_URL}/api/Inventory/GetInventoryItem?stockItemId=${item.StockItemId}&sKU=${item.SKU}`,
              method: "GET",
              headers: {
                Authorization: token,
              },
            });
            if (res1.status !== 200) throw new Error("get inventory api error");
            const res2 = await axios({
              url: `${BASE_URL}/api/Inventory/UpdateInventoryItem`,
              method: "POST",
              headers: {
                Authorization: token,
              },
              data: {
                inventoryItem: {
                  ...res1.data,
                  ItemTitle: item.SKU,
                },
              },
            });
            if (res2.status !== 204) throw new Error("update inventory failed");
          }),
        );
        await updateItem(item, token);
      } catch (err) {
        console.log(
          `Item update failed for order: ${order.NumOrderId}, ItemId: ${item.ItemId}`,
        );
        throw err;
      }
    }
  }
}

async function changeCountry(order, token) {
  try {
    const changeCountryWrapper = handleRetries(
      updateCountryLimiter.wrap(async (order, token) => {
        const res = await axios({
          url: `${BASE_URL}/api/Orders/SetOrderCustomerInfo`,
          method: "POST",
          headers: {
            Authorization: token,
          },
          data: {
            orderId: order.OrderId,
            info: {
              ChannelBuyerName: order.CustomerInfo.ChannelBuyerName,
              Address: {
                ...order.CustomerInfo.Address,
                Country: "United Kingdom",
                CountryId: UK_COUNTRY_ID,
              },
            },
          },
        });
        if (res.status !== 200)
          throw new Error("update Country operation failed");
        console.log(
          `successfully changed country to uk, for order: ${order.OrderId} , NumOrderId: ${order.NumOrderId}`,
        );
      }),
    );
    await changeCountryWrapper(order, token);
  } catch (err) {
    console.log(
      `country update FAILED for order: ${order.OrderId} , NumOrderId: ${order.NumOrderId}`,
    );
    throw err;
  }
}

async function changeShippingMethod(order, token, PostalServiceId) {
  try {
    const changeShippingMethodWrapper = handleRetries(
      changeShippingMethodLimiter.wrap(
        async (order, token, PostalServiceId) => {
          const res = await axios({
            url: `${BASE_URL}/api/Orders/SetOrderShippingInfo`,
            method: "POST",
            headers: {
              Authorization: token,
            },
            data: {
              OrderId: order.OrderId,
              info: {
                PostalServiceId,
              },
            },
          });
          if (res.status !== 200) throw new Error("shipping update api error");
          console.log(
            `successfully update shipping service, for order: ${order.OrderId} , NumOrderId: ${order.NumOrderId}`,
          );
        },
      ),
    );
    await changeShippingMethodWrapper(order, token, PostalServiceId);
  } catch (err) {
    console.log(
      `shippingMethod Update FAILED, order: ${order.OrderId} , NumOrderId: ${order.NumOrderId}`,
    );
    throw err;
  }
}

async function setOrderPackagingCalculation(order, token, isNoWeight) {
  const wt = isNoWeight ? 0.68 : order.ShippingInfo.TotalWeight;
  try {
    const setOrderPackagingCalcWrapper = handleRetries(
      setOrderPackagingLimiter.wrap(async (wt, order, token) => {
        const res = await axios({
          url: `${BASE_URL}/api/Orders/SetOrderPackaging`,
          method: "POST",
          headers: {
            Authorization: token,
          },
          data: {
            request: {
              pkOrderId: order.OrderId,
              TotalWeight: wt,
              TotalHeight: 15,
              TotalWidth: 20,
              TotalDepth: 10,
              ManualAdjust: true,
            },
          },
        });
        if (res.status !== 200)
          throw new Error("order packaging calc api error");
        console.log(
          `Order, id: ${order.OrderId} NumOrderId: ${order.NumOrderId} pkg calculation successful`,
        );
      }),
    );
    await setOrderPackagingCalcWrapper(wt, order, token);
  } catch (err) {
    console.log(
      `Order, id: ${order.OrderId} NumOrderId: ${order.NumOrderId} pkg calculation failed`,
    );
    throw err;
  }
}

async function getOpenOrders(token) {
  const orders = [];
  let page = 1;
  while (true) {
    const getOpenOrdersRes = handleRetries(async (token) => {
      return await axios({
        url: `${BASE_URL}/api/OpenOrders/GetOpenOrders`,
        method: "POST",
        headers: {
          Authorization: token,
        },
        data: {
          ViewId: 13,
          LocationId: "3adfb53a-61f1-4c92-9466-9c051f603e48",
          EntriesPerPage: 500,
          PageNumber: page,
        },
      });
    });
    const openOrdersRes = await getOpenOrdersRes(token);
    if (openOrdersRes.data.Data.length > 1) {
      orders.push(...openOrdersRes.data.Data);
      page++;
    } else break;
  }
  return orders;
}

async function fetchOrders(token, ukTime) {
  let page = 1;
  let count = 0;
  let doubleCount = 0;
  try {
    const orders = await getOpenOrders(token);
    // let orders = await fetchTestOrders(token, BASE_URL);
    for (let i = 0; i < orders.length; i++) {
      let order = orders[i];
      if (isAmazonShoes(order)) {
        try {
          order = await getNumOrderWrapper(token, order.NumOrderId);
        } catch (err) {
          console.log(`unable to fetch order data, skipping...`);
          continue;
        }
        const data = `${order.OrderId}|${order.NumOrderId}`;
        // 10kg weight check
        if (!order.hasOwnProperty("ShippingInfo")) {
          console.log(`order ${order.NumOrderId} has no shipping info`);
          continue;
        }
        if (order.ShippingInfo.TotalWeight > 10) continue;
        // amazon prime check
        const identifiers = order.GeneralInfo?.Identifiers; //.some(id => id.IdentifierId === 2);
        if (identifiers == null || !Array.isArray(identifiers)) continue; // UPDATED
        let isPrime = false;
        for (let k = 0; k < identifiers.length; k++) {
          const idf = identifiers[k];
          if (
            (idf.IdentifierId && idf.IdentifierId === 2) ||
            (idf.Tag &&
              typeof idf.Tag === "string" &&
              idf.Tag.trim().toLowerCase().includes("amazon_prime")) ||
            (idf.Name &&
              typeof idf.Name === "string" &&
              idf.Name.trim().toLowerCase().includes("amazon prime"))
          ) {
            isPrime = true;
            break;
          }
        }
        //orders.push(order); // for testing purposes only
        if (isPrime) {
          if (order.ShippingInfo.PostalServiceId !== ABS_EVRI_LINKED_NEXT_DAY) {
            try {
              await changeShippingMethod(
                order,
                token,
                ABS_EVRI_LINKED_NEXT_DAY,
              );
            } catch (err) {
              console.log(
                `ERR!, stack: ${err.stack}, msg: ${err.message} status: ${err.response?.status} data: ${JSON.stringify(err.response?.data)}`,
              );
              continue;
            }
          }
        } else {
          if (order.ShippingInfo.PostalServiceId !== M7_48) {
            try {
              await changeShippingMethod(order, token, M7_48);
            } catch (err) {
              console.log(
                `ERR!, stack: ${err.stack}, msg: ${err.message} status: ${err.response?.status} data: ${JSON.stringify(err.response?.data)}`,
              );
              continue;
            }
          }
        }
        // dimension check  AND rate-limit check: 150/minute
        let pkgCalcRes;
        try {
          pkgCalcRes = await getPkgCalc(order, token);
        } catch (err) {
          console.log(`get pkg calculation failed, order: ${order.NumOrderId}`);
          console.log(
            `ERR!, stack: ${err.stack}, msg: ${err.message} status: ${err.response?.status} data: ${JSON.stringify(err.response?.data)}`,
          );
          continue;
        }

        if (
          order.ShippingInfo.TotalWeight < 0.1 ||
          (pkgCalcRes.data.length > 0 &&
            pkgCalcRes.data[0].TotalHeight === 0 &&
            pkgCalcRes.data[0].TotalDepth === 0 &&
            pkgCalcRes.data[0].TotalWidth === 0)
        ) {
          console.log(`updating order ${order.NumOrderId} dimensions...`);
          const isNoWeight = order.ShippingInfo.TotalWeight < 0.1;
          try {
            console.log(`found a zero-dimension order: ${order.NumOrderId}`);
            if (isNoWeight)
              console.log(`founded a no weight order: ${order.NumOrderId}`);
            await setOrderPackagingCalculation(order, token, isNoWeight);
          } catch (err) {
            console.log(err);
            console.log(
              `ERR!, stack: ${err.stack}, msg: ${err.message} status: ${err.response?.status} data: ${JSON.stringify(err.response?.data)}`,
            );
            continue;
          }
        }
        // check item titles
        try {
          await changeItemObject(order, token);
        } catch (err) {
          console.log(
            `ERR!, stack: ${err.stack}, msg: ${err.message} status: ${err.response?.status} stack: ${err.stack} data: ${JSON.stringify(err.response?.data || {})}`,
          );
          continue;
        }

        if (
          order.CustomerInfo.Address.Country.toLowerCase() !== "united kingdom"
        ) {
          console.log(`updating order ${order.NumOrderId} country...`);
          try {
            await changeCountry(order, token);
          } catch (err) {
            console.log(
              `ERR!, stack: ${err.stack}, msg: ${err.message} status: ${err.response?.status} data: ${JSON.stringify(err.response?.data)}`,
            );
            continue;
          }
        }

        if (order.Items.length > 1) {
          doubleCount++;
          ukDoubleOrders.push(data);
          continue;
        }
        count++;
        let binRack = "";
        let isBinRackFound = false;
        if (order.Items.length > 0) {
          for (let i = 0; i < order.Items.length; i++) {
            const item = order.Items[i];
            if (item.hasOwnProperty("BinRacks")) {
              const binracks = item.BinRacks;
              for (let j = 0; j < binracks.length; j++) {
                if (
                  binracks[j].hasOwnProperty("BinRack") &&
                  binracks[j].BinRack.trim() !== ""
                ) {
                  binRack = binracks[j].BinRack.toLowerCase();
                  isBinRackFound = true;
                  break;
                }
              }
            }
            if (isBinRackFound) break;
          }
        }
        ukSingleOrders[binRack] = ukSingleOrders[binRack] || [];
        ukSingleOrders[binRack].push(data);
      }
    }

    console.log(`uk single orders: ${count}`);
    console.log(`uk double orders: ${doubleCount}`);
    sortedKeys = Object.keys(ukSingleOrders);
    processSortedKeys(sortedKeys);
    console.log(`finished fetching orders!`);
  } catch (err) {
    throw err;
  }
}

function processSortedKeys(keysArr) {
  keysArr.sort();
  if (keysArr.length > 0 && keysArr[0] === "") {
    const emptyKey = keysArr.shift();
    keysArr.push(emptyKey);
  }
}

async function printUKSingleOrders(token, FolderId, ukTime) {
  let x = [];
  const maxLimit = 50;
  try {
    for (const key of sortedKeys) {
      const dataLen = ukSingleOrders[key].length;
      let i = 0;
      while (i < dataLen) {
        if (x.length === maxLimit) {
          await clearInvoiceFolder();
          await downloadAndUpload(x, token, FolderId, "single", ukTime);
          x = [];
        }
        const spaceLeft = maxLimit - x.length;
        const currentLen = dataLen - i;
        if (currentLen <= spaceLeft) {
          x.push(...ukSingleOrders[key].slice(i, i + currentLen));
          i += currentLen;
        } else {
          x.push(...ukSingleOrders[key].slice(i, i + spaceLeft));
          i += spaceLeft;
        }
      }
    }
    if (x.length > 0) {
      await clearInvoiceFolder();
      await downloadAndUpload(x, token, FolderId, "single", ukTime);
      x = [];
    }
    console.log(`total ${pdfCount} pdfs uploaded`);
  } catch (err) {
    throw err;
  }
}

async function printUKDoubleOrders(token, FolderId, ukTime) {
  const maxLimit = 50;
  let tmp = [];
  try {
    const dataLen = ukDoubleOrders.length;
    let i = 0;
    while (i < dataLen) {
      if (tmp.length === maxLimit) {
        await clearInvoiceFolder();
        await downloadAndUpload(tmp, token, FolderId, "double", ukTime);
        tmp = [];
      }
      const spaceLeft = maxLimit - tmp.length;
      const currentLen = dataLen - i;
      if (currentLen <= spaceLeft) {
        tmp.push(...ukDoubleOrders.slice(i, i + currentLen));
        i += currentLen;
      } else {
        tmp.push(...ukDoubleOrders.slice(i, i + spaceLeft));
        i += spaceLeft;
      }
    }
    if (tmp.length > 0) {
      await clearInvoiceFolder();
      await downloadAndUpload(tmp, token, FolderId, "double", ukTime);
      tmp = [];
    }
  } catch (err) {
    throw err;
  }
}

async function clearInvoiceFolder() {
  try {
    const invoiceFiles = await fsp.readdir(invoiceFolderPath);
    for (const file of invoiceFiles) {
      const filePath = `${invoiceFolderPath}/${file}`;
      await fsp.unlink(filePath);
    }
  } catch (err) {
    console.log(`Error clearing invoice folder`);
    throw err;
  }
}

async function downloadAndUpload(ids, token, FolderId, orderType, ukTime) {
  console.log(`Printing ids:`);
  ids.forEach((id) => console.log(id));
  const orderIds = ids.map((id) => id.split("|")[0]);
  pdfCount++;
  let pdfUrl = "";
  let res;
  let pdfName = "";
  try {
    const printHandler = handleRetries(async (token, orderIds) => {
      return await axios({
        url: `${BASE_URL}/api/PrintService/CreatePDFfromJobForceTemplate`,
        method: "POST",
        headers: {
          Authorization: token,
        },
        data: {
          templateType: "Invoice Template",
          IDs: orderIds,
        },
      });
    });
    try {
      res = await printHandler(token, orderIds);
    } catch (err) {
      console.log(`ERROR PRINTING AMAZON SHOES ORDERS!`);
      console.log(`ids: ${JSON.stringify(ids, null, 2)}`);
      console.log(`count: ${pdfCount}`);
      console.log(`time: ${ukTime}`);
      const errorMsg =
        err instanceof Error
          ? `ERROR: ${err.message}\nSTACK: ${err.stack}`
          : `ERROR: ${JSON.stringify(err, null, 2)}`;
      console.log(errorMsg);
      printError.push({
        msg: `Amazon Shoes orders print failed`,
        orders: ids,
        time: ukTime,
      });
      return;
    }
    //console.log(res.data)
    let errorCount = 0;
    if (res.data.KeyedError.length > 0 || res.data.PrintErrors.length > 0) {
      errorCount = res.data.KeyedError.length || res.data.PrintErrors.length;
      for (let i = 0; i < res.data.PrintErrors.length; i++) {
        const errorData = res.data.PrintErrors[i];
        if (errorData.includes("insufficient stock") === false) {
          invoicePrintError.push({
            PrintError: errorData,
            time: ukTime,
          });
        }
      }
      for (let i = 0; i < res.data.KeyedError.length; i++) {
        const errorData = res.data.KeyedError[i];
        if (errorData.Error.includes("insufficient stock") === false) {
          invoicePrintError.push({
            KeyedError: errorData,
            time: ukTime,
          });
        }
      }
    }
    const pdfUrl = res.data.URL;
    console.log(`pdf url: ${pdfUrl}`);
    const downloadFilePath = `${invoiceFolderPath}/${orderType}_${pdfCount}_${ids.length - errorCount}.pdf`;
    pdfName = downloadFilePath;
    await downloadFile(pdfUrl, downloadFilePath);
    const invoiceFiles = await fsp.readdir(invoiceFolderPath);
    const uploadPromises = [];
    for (const file of invoiceFiles) {
      uploadPromises.push(
        limiter.schedule(
          handleRetries(async () => {
            const filePath = `${invoiceFolderPath}/${file}`;
            const requestBody = {
              name: `${file}`,
              parents: [`${FolderId}`],
            };
            const media = {
              mimeType: "application/pdf",
              body: fs.createReadStream(filePath),
            };
            const res = await driveApi.files.create({
              requestBody,
              media,
              fields: "id",
            });
            console.log(`Uploaded: ${requestBody.name}, id: ${res.data.id}`);
          }),
        ),
      );
    }
    await Promise.all(uploadPromises);
    console.log(`Upload Success`);
  } catch (err) {
    console.log(`ERROR UPLOADING AMAZONE SHOES ORDERS!`);
    console.log(`pdfName: ${pdfName}`);
    console.log(`ids: ${JSON.stringify(ids, null, 2)}`);
    console.log(`count: ${pdfCount}`);
    console.log(`url: ${pdfUrl}`);
    console.log(`time: ${ukTime}`);
    //pdfCount--;
    const errorMsg =
      err instanceof Error
        ? `ERROR: ${err.message}\nSTACK: ${err.stack}`
        : `ERROR: ${JSON.stringify(err, null, 2)}`;
    console.log(errorMsg);
    printError.push({
      msg: `Amazon Shoes upload failed`,
      pdfName,
      url: `${pdfUrl}`,
      orders: ids,
      time: ukTime,
    });
  }
}

async function downloadFile(url, filePath) {
  let response;
  try {
    const resHandler = handleRetries(async (url) => {
      return await axios({
        url: url,
        method: "GET",
        responseType: "stream",
      });
    });
    response = await resHandler(url);
  } catch (err) {
    console.error("Download request failed:");
    throw err;
  }

  const writer = fs.createWriteStream(filePath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", (err) => {
      console.error("File write failed:");
      reject(err);
    });
    // Handle response stream errors
    response.data.on("error", (err) => {
      console.error("Download stream failed:");
      writer.destroy();
      reject(err);
    });
  });
}

function getBatchTime(date) {
  const day = date.split(",")[0].trim().toLowerCase();
  const getHours = Number(date.split(",")[2].trim().split(":")[0]);
  const getMinutes = Number(date.split(",")[2].trim().split(":")[1]);
  const current_seconds = getHours * 60 * 60 + getMinutes * 60;
  let batch_timings;
  let arr;
  if (day === "sunday") {
    batch_timings = ["8:00"];
    arr = ["08.00 AM"];
  } else {
    batch_timings = ["7:00", "10:00", "12:00", "14:30", "15:45"];
    arr = ["07.00 AM", "10.00 AM", "12.00 PM", "02.30 PM", "03.45 PM"];
  }
  let ind = 0;
  let mini = 1e6;
  for (let i = 0; i < batch_timings.length; i++) {
    const batch_timing_arr = batch_timings[i].split(":");
    const batch_seconds =
      Number(batch_timing_arr[0]) * 60 * 60 + Number(batch_timing_arr[1]) * 60;
    const diff = batch_seconds - current_seconds;
    if (mini > diff && diff > 0) {
      mini = diff;
      ind = i;
    }
  }
  const dateOnly = date
    .split(",")[1]
    .split("/")
    .map((part, index) => (index === 2 ? part.slice(-2) : part))
    .join(".")
    .trim();
  const batchTime = `${dateOnly} ${arr[ind]}`;
  return batchTime;
}

async function createFolder(folderName, parentFolderId) {
  try {
    const getFiles = handleRetries(async () => {
      return await driveApi.files.list({
        fields: "files(id, name)",
        q: `'${parentFolderId}' in  parents and name= '${folderName}'`,
        spaces: "drive",
      });
    });
    const res = await getFiles();
    if (res.data.files.length === 0) {
      console.log(`folder ${folderName} not found, creating it...`);
      const fileMetadata = {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [`${parentFolderId}`],
      };
      const createFile = handleRetries(async () => {
        return await driveApi.files.create({
          requestBody: fileMetadata,
          fields: "id",
        });
      });
      const file = await createFile();
      console.log("Folder created, Id:", file.data.id);
      return file.data.id;
    } else return res.data.files[0].id;
  } catch (err) {
    throw err;
  }
}

export async function amazon_handler(event) {
  console.time("timer");
  ukSingleOrders = {};
  ukDoubleOrders = [];
  sortedKeys = [];
  pdfCount = 0;
  invoicePrintError = [];
  printError = [];
  const date = new Date();
  const ukTime = date.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  console.log("ukTime: ", ukTime);
  try {
    checkEnvVar();
    await fsp.mkdir(invoiceFolderPath, { recursive: true });
    client2 = new JWT({
      email: client_email2,
      key: formatted_key2,
      scopes: [
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
    });
    driveApi = drive({ version: "v3", auth: client2 });
    const dateFolderName = ukTime
      .split(",")[1]
      .split("/")
      .map((part, index) => (index === 2 ? part.slice(-2) : part))
      .join(".")
      .trim();
    const dateFolderId = await createFolder(dateFolderName, root_folder_id);
    const dateTimeFolderName = getBatchTime(ukTime);
    const dateTimeFolderId = await createFolder(
      dateTimeFolderName,
      dateFolderId,
    );
    const amazonFolderName = "Amazon";
    const amazonFolderId = await createFolder(
      amazonFolderName,
      dateTimeFolderId,
    );
    const auth = await authorize();
    await fetchOrders(auth.Token, ukTime);
    await printUKSingleOrders(auth.Token, amazonFolderId, ukTime);
    pdfCount = 0;
    await printUKDoubleOrders(auth.Token, amazonFolderId, ukTime);
    console.log("All files uploaded successfully.");
    console.timeEnd("timer");
    if (invoicePrintError.length > 0) {
      console.log("INVOICE PRINT ERRORS: ");
      console.log(JSON.stringify(invoicePrintError, null, 2));
    }
    if (printError.length > 0) {
      try {
        const sendSnsMsg = handleRetries(async () => {
          await sns
            .publish({
              TopicArn: SNS_TOPIC_ARN,
              Subject: "Amazon Shoes Critical Error!",
              Message: JSON.stringify(printError, null, 2),
            })
            .promise();
        });
        await sendSnsMsg();
      } catch (err) {
        console.log("SNS MESSAGE FAILED");
        console.log(err);
      }
    }
  } catch (err) {
    const errorMsg =
      err instanceof Error
        ? `ERROR: ${err.message}\nSTACK: ${err.stack}`
        : `ERROR: ${JSON.stringify(err, null, 2)}`;
    console.log(`AMAZON SHOES AUTOMATION FAILED!`);
    console.log(errorMsg);
    try {
      const sendSnsMsg = handleRetries(async () => {
        await sns
          .publish({
            TopicArn: SNS_TOPIC_ARN,
            Subject: "Amazon Shoes Automation Failed!",
            Message: "",
          })
          .promise();
      });
      await sendSnsMsg();
    } catch (err) {
      console.log("SNS MESSAGE FAILED");
      console.log(err);
    }
  }
}

function checkEnvVar() {
  const requiredEnvVars = [
    "CLIENT_EMAIL",
    "PRIVATE_KEY",
    "ROOT_FOLDER_ID4",
    "LINNWORKS_APP_ID",
    "LINNWORKS_APP_SECRET",
    "LINNWORKS_API_TOKEN",
    "LINNWORKS_BASE_URL",
    "ABS_EVRI_LINKED_NEXT_DAY",
    "EVRI_M7_48",
    "UK_COUNTRY_ID",
  ];

  for (const key of requiredEnvVars) {
    if (!process.env[key] || process.env[key].trim() === "") {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }
}
